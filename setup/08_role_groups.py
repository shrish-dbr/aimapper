#!/usr/bin/env python3
"""One-time setup of AI Mapper's role groups.

Each app role is an ACCOUNT group that holds the role's resource permissions:
    aimapper-admins   aimapper-editors   aimapper-viewers
Assigning a role in Admin → Roles just adds the person (or group) to the group.

This script, run by a workspace admin with the Databricks CLI:
  1. creates any missing role group as an account group (via the workspace's
     account-SCIM proxy) and assigns it to this workspace;
  2. makes the app's service principal a Group manager of each group — the app
     changes membership as its SP, because user sign-in tokens can't carry the
     `scim` scope (the app checks the caller is an app admin first);
  3. grants the groups access to the app and the Genie space (these two can't be set
     from inside the app — app sign-in tokens can't carry the needed scope);
  4. optionally adds a first admin to aimapper-admins.

Then open the app → Admin → Roles → "Apply group permissions" to grant the three
groups the access each role needs (app, SQL warehouse, Genie,
Vector Search, Unity Catalog). It runs with your identity and is safe to re-run.

Usage:
  python3 setup/08_role_groups.py --profile my_profile [--app aimapper] [--first-admin me@example.com]
Group names can be changed with --admin-group/--editor-group/--viewer-group; set the same
names in app.yaml (AIMAPPER_ADMIN_GROUP / AIMAPPER_EDITOR_GROUP / AIMAPPER_VIEWER_GROUP).
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.parse

SCIM_GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group"
SCIM_PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp"
MANAGER = "roles/group.manager"


def cli(profile: str, *args: str, body: dict | None = None) -> dict | None:
    cmd = ["databricks", *args, "--profile", profile, "-o", "json"]
    if body is not None:
        cmd += ["--json", json.dumps(body)]
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"{' '.join(args[:3])}: {out.stderr.strip() or out.stdout.strip()}")
    return json.loads(out.stdout) if out.stdout.strip() and out.stdout.strip() != "null" else None


def api(profile: str, method: str, path: str, query: dict | None = None, body: dict | None = None) -> dict | None:
    if query:
        path = f"{path}?{urllib.parse.urlencode(query, quote_via=urllib.parse.quote)}"
    return cli(profile, "api", method, path, body=body)


def scim_eq(attr: str, value: str) -> str:
    return f'{attr} eq "' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def genie_space_from_app_yaml() -> str | None:
    """AIMAPPER_GENIE_SPACE_ID's value from app.yaml next to this script's parent dir."""
    import os
    import re
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app.yaml")
    try:
        text = open(path).read()
    except OSError:
        return None
    m = re.search(r'name:\s*AIMAPPER_GENIE_SPACE_ID\s*\n\s*value:\s*"?([^"\s]*)"?', text)
    return m.group(1) if m and m.group(1) else None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--profile", required=True)
    ap.add_argument("--app", default="aimapper")
    ap.add_argument("--admin-group", default="aimapper-admins")
    ap.add_argument("--editor-group", default="aimapper-editors")
    ap.add_argument("--viewer-group", default="aimapper-viewers")
    ap.add_argument("--first-admin", help="Email to add to the admin group")
    ap.add_argument("--account-id", help="Databricks account id (auto-detected if omitted)")
    ap.add_argument("--genie-space", help="Genie space id (default: AIMAPPER_GENIE_SPACE_ID from app.yaml)")
    a = ap.parse_args()
    p = a.profile

    host = (cli(p, "auth", "describe") or {}).get("details", {}).get("host", "").rstrip("/")
    # Via the CLI (not urllib) so corporate TLS proxies / custom CA bundles just work.
    account_id = a.account_id or (api(p, "get", "/.well-known/databricks-config") or {}).get("account_id")
    if not account_id:
        print("Could not resolve the account id — pass --account-id.", file=sys.stderr)
        return 1
    app = cli(p, "apps", "get", a.app) or {}
    sp = app.get("service_principal_client_id")
    if not sp:
        print(f"App '{a.app}' has no service principal yet — deploy it first.", file=sys.stderr)
        return 1
    print(f"Workspace {host}  account {account_id}  app SP {sp}")

    group_ids: dict[str, str] = {}
    for name in (a.admin_group, a.editor_group, a.viewer_group):
        found = (api(p, "get", "/api/2.0/account/scim/v2/Groups", {"filter": scim_eq("displayName", name), "attributes": "id,displayName"}) or {}).get("Resources") or []
        if found:
            gid = found[0]["id"]
            print(f"• {name}: exists ({gid})")
        else:
            gid = api(p, "post", "/api/2.0/account/scim/v2/Groups", body={"schemas": [SCIM_GROUP], "displayName": name})["id"]
            print(f"• {name}: created account group ({gid})")
        group_ids[name] = gid
        # Make it usable in this workspace (idempotent).
        api(p, "put", f"/api/2.0/preview/permissionassignments/principals/{gid}", body={"permissions": ["USER"]})
        print("    assigned to workspace")
        # App SP as Group manager, keeping every existing rule.
        rs_name = f"accounts/{account_id}/groups/{gid}/ruleSets/default"
        rs = api(p, "get", "/api/2.0/preview/accounts/access-control/rule-sets", {"name": rs_name, "etag": ""}) or {}
        rules = rs.get("grant_rules") or []
        sp_ref = f"servicePrincipals/{sp}"
        mgr = next((r for r in rules if r.get("role") == MANAGER), None)
        if mgr and sp_ref in (mgr.get("principals") or []):
            print("    app SP already a Group manager")
            continue
        if mgr:
            mgr["principals"] = [*mgr.get("principals", []), sp_ref]
        else:
            rules.append({"role": MANAGER, "principals": [sp_ref]})
        api(p, "put", "/api/2.0/preview/accounts/access-control/rule-sets",
            body={"name": rs_name, "rule_set": {"name": rs_name, "etag": rs.get("etag", ""), "grant_rules": rules}})
        print("    app SP made Group manager")

    # App + Genie permissions for the groups (PATCH merges; other entries untouched).
    levels = {
        "apps": {a.admin_group: "CAN_MANAGE", a.editor_group: "CAN_USE", a.viewer_group: "CAN_USE"},
        "genie": {a.admin_group: "CAN_MANAGE", a.editor_group: "CAN_RUN", a.viewer_group: "CAN_RUN"},
    }
    genie = a.genie_space or genie_space_from_app_yaml()
    for obj_type, obj_id, label in (("apps", a.app, f"app {a.app}"), ("genie", genie, f"Genie space {genie}")):
        if not obj_id:
            print(f"• {label}: not configured — skipped")
            continue
        acl = [{"group_name": g, "permission_level": lvl} for g, lvl in levels[obj_type].items()]
        api(p, "patch", f"/api/2.0/permissions/{obj_type}/{obj_id}", body={"access_control_list": acl})
        print(f"• {label}: " + ", ".join(f"{g} {lvl}" for g, lvl in levels[obj_type].items()))

    if a.first_admin:
        users = (api(p, "get", "/api/2.0/account/scim/v2/Users", {"filter": scim_eq("userName", a.first_admin), "attributes": "id"}) or {}).get("Resources") or []
        if not users:
            print(f"No account user {a.first_admin}; skipped.", file=sys.stderr)
        else:
            api(p, "patch", f"/api/2.0/account/scim/v2/Groups/{group_ids[a.admin_group]}",
                body={"schemas": [SCIM_PATCH], "Operations": [{"op": "add", "path": "members", "value": [{"value": users[0]["id"]}]}]})
            print(f"Added {a.first_admin} to {a.admin_group}")

    print("\nNext: open the app → Admin → Roles → “Apply group permissions” (warehouse,")
    print("Vector Search and Unity Catalog grants).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
