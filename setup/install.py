#!/usr/bin/env python3
"""AI Mapper installer — one command to install, update, check or remove the app.

    python3 setup/install.py install   --profile <profile> --catalog <catalog>
    python3 setup/install.py status    --profile <profile>            # read-only check
    python3 setup/install.py deploy    --profile <profile>            # redeploy code only
    python3 setup/install.py uninstall --profile <profile> [--all]    # remove the app

Every step first checks what already exists, so `install` is safe to re-run: after a
failure, fix the cause and run the same command again — finished steps are skipped
or re-verified, existing data is never overwritten. Settings are saved per app in
.databricks/installs/<app>.json (git-ignored), so re-runs don't need them again.

Needs only Python 3.9+ and the Databricks CLI (signed in: `databricks auth login`).
All calls go through the CLI, so corporate proxies / custom CA bundles just work.
Run `python3 setup/install.py <command> --help` for every option.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SETUP = ROOT / "setup"
STATE_DIR = ROOT / ".databricks" / "installs"
GENERATED_DIR = ROOT / ".databricks" / "generated"
LOCAL_BUNDLE_CACHE = ROOT / ".databricks" / "bundle"
MIN_CLI = (1, 18, 0)
EMBEDDING_ENDPOINT = "databricks-gte-large-en"
SCIM_GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group"
SCIM_PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp"
# What a workspace admin sets up first when the installer is run by a non-admin.
NON_ADMIN_README = "README → Prerequisites → If you aren't a workspace admin"
SQL_FILES = ["01_create_tables.sql", "02_seed_target_schema.sql", "03_sample_source.sql",
             "04_examples.sql", "05_reference_docs.sql", "06_retrieval_corpus.sql",
             "07_reference_chunks.sql"]
SEED_FILES = {"02_seed_target_schema.sql"}          # only on a fresh install / --reseed
SAMPLE_FILES = {"03_sample_source.sql"}             # demo source data
INDEXES = {
    # bundle key → (table suffix, primary key, embedding column, columns to sync)
    "retrieval_index": ("aimapper_retrieval_index", "aimapper_retrieval_corpus", "id", "content",
                        ["id", "kind", "domain", "project_id", "target_table", "source_signature", "content", "generated_sql"]),
    "reference_index": ("aimapper_reference_index", "aimapper_reference_chunks", "chunk_id", "embed_text",
                        ["chunk_id", "source_system", "file_name", "file_path", "chunk_index", "page_start", "page_end",
                         "heading", "content", "char_count", "embed_text"]),
}
# Tables each role writes through the app. KEEP IN SYNC with server/aimapper/permissions.ts
# (tests/installer.test.ts checks the two lists match).
VIEWER_WRITE_TABLES = ["aimapper_conversion_runs", "aimapper_run_steps", "aimapper_feedback", "aimapper_user_prefs"]
EDITOR_WRITE_TABLES = VIEWER_WRITE_TABLES + ["mapping_examples", "aimapper_retrieval_corpus", "aimapper_projects",
                                             "aimapper_domain_instructions", "aimapper_reference_chunks"]


# --------------------------------------------------------------------------- output
def say(msg: str = "") -> None:
    print(msg, flush=True)


def ok(msg: str) -> None:
    say(f"    ✓ {msg}")


def warn(msg: str) -> None:
    say(f"    ! {msg}")


class InstallError(Exception):
    """A step failed. `hint` tells the user what to fix before re-running."""

    def __init__(self, message: str, hint: str | None = None):
        super().__init__(message)
        self.hint = hint


def hint_for(err: str) -> str | None:
    """Turn common API errors into an actionable fix."""
    e = err.lower()
    if "certificate" in e or "ssl" in e:
        return "TLS/certificate problem talking to Databricks. Check your proxy / CA settings for the Databricks CLI."
    if "unauthenticated" in e or "invalid access token" in e or "token is expired" in e or "refresh token" in e:
        return "Your CLI login expired. Run `databricks auth login --profile <profile>` and re-run."
    if "permission_denied" in e or "does not have" in e or "not authorized" in e or "forbidden" in e or "403" in e:
        return ("You don't have the privilege this step needs. Ask a workspace/metastore admin for it "
                f"(see README → Prerequisites, and {NON_ADMIN_README}), then re-run.")
    if "does not exist" in e or "not found" in e or "404" in e:
        return "Something this step depends on is missing — check the names you passed (catalog, warehouse, endpoint)."
    if "quota" in e or "limit" in e and "exceed" in e:
        return "A workspace quota/limit was hit (e.g. Vector Search endpoints or apps). Free one up or ask an admin."
    if "temporarily unavailable" in e or "timed out" in e or "timeout" in e or "503" in e or "502" in e:
        return "Databricks was briefly unavailable. Wait a minute and re-run — finished steps are skipped."
    return None


# --------------------------------------------------------------------------- CLI
class Cli:
    def __init__(self, profile: str, verbose: bool = False):
        self.profile = profile
        self.verbose = verbose

    def run(self, *args: str, body: dict | None = None, json_out: bool = True, timeout: int = 900,
            check: bool = True, use_profile: bool = True) -> dict | list | str | None:
        cmd = ["databricks", *args] + (["--profile", self.profile] if use_profile else [])
        if json_out:
            cmd += ["-o", "json"]
        if body is not None:
            cmd += ["--json", json.dumps(body)]
        if self.verbose:
            say(f"      $ {' '.join(cmd)[:300]}")
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=ROOT)
        except FileNotFoundError:
            raise InstallError("The Databricks CLI (`databricks`) is not on your PATH.",
                               "Install it: https://docs.databricks.com/dev-tools/cli/install.html") from None
        except subprocess.TimeoutExpired:
            raise InstallError(f"`databricks {' '.join(args[:3])}` timed out after {timeout}s.",
                               "Databricks may be slow right now — re-run; finished steps are skipped.") from None
        if out.returncode != 0:
            msg = (out.stderr or out.stdout).strip()
            if not check:
                return {"__error__": msg}
            raise InstallError(f"`databricks {' '.join(args[:3])}` failed: {msg[:800]}", hint_for(msg))
        text = out.stdout.strip()
        if not json_out:
            return text
        if not text or text == "null":
            return None
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text

    def api(self, method: str, path: str, query: dict | None = None, body: dict | None = None,
            check: bool = True) -> dict | list | None:
        if query:
            path = f"{path}?{urllib.parse.urlencode(query, quote_via=urllib.parse.quote)}"
        res = self.run("api", method, path, body=body, check=check)
        return res if isinstance(res, (dict, list)) or res is None else {"raw": res}

    def missing(self, res: object) -> bool:
        """True if a check=False call failed because the thing doesn't exist."""
        if not (isinstance(res, dict) and "__error__" in res):
            return False
        e = res["__error__"].lower()
        return "does not exist" in e or "not found" in e or "not_found" in e or "404" in e

    def failed(self, res: object) -> str | None:
        return res["__error__"] if isinstance(res, dict) and "__error__" in res else None


# --------------------------------------------------------------------------- SQL
class Sql:
    def __init__(self, cli: Cli, warehouse_id: str):
        self.cli = cli
        self.warehouse_id = warehouse_id

    def run(self, statement: str, catalog: str | None = None, schema: str | None = None) -> list[dict]:
        body: dict = {"statement": statement, "warehouse_id": self.warehouse_id,
                      "wait_timeout": "50s", "on_wait_timeout": "CONTINUE", "format": "JSON_ARRAY"}
        if catalog:
            body["catalog"] = catalog
        if schema:
            body["schema"] = schema
        resp = self.cli.api("post", "/api/2.0/sql/statements", body=body) or {}
        deadline = time.time() + 1800
        while (resp.get("status") or {}).get("state") in ("PENDING", "RUNNING"):
            if time.time() > deadline:
                raise InstallError("A SQL statement ran for over 30 minutes.", "Check the warehouse is running and not overloaded.")
            time.sleep(3)
            resp = self.cli.api("get", f"/api/2.0/sql/statements/{resp['statement_id']}") or {}
        status = resp.get("status") or {}
        if status.get("state") != "SUCCEEDED":
            err = (status.get("error") or {}).get("message") or status.get("state") or "unknown error"
            raise InstallError(f"SQL failed: {err[:600]}\n      statement: {statement.strip()[:240]}", hint_for(err))
        cols = [c["name"] for c in ((resp.get("manifest") or {}).get("schema") or {}).get("columns", [])]
        rows = (resp.get("result") or {}).get("data_array") or []
        return [dict(zip(cols, r)) for r in rows]


def substitute(sql: str, catalog: str, schema: str) -> str:
    """Rewrite the SQL files' placeholder names (your_catalog / aimapper). Names are
    backtick-quoted so catalogs/schemas like `my-catalog` stay valid SQL."""
    sql = sql.replace("your_catalog.aimapper_source", fq(catalog, f"{schema}_source"))
    sql = sql.replace("your_catalog.aimapper", fq(catalog, schema))
    sql = re.sub(r"\bUSE\s+CATALOG\s+your_catalog\b", lambda _: f"USE CATALOG {q(catalog)}", sql)
    sql = re.sub(r"\bUSE\s+SCHEMA\s+aimapper\b", lambda _: f"USE SCHEMA {q(schema)}", sql)
    return re.sub(r"\byour_catalog\b", lambda _: q(catalog), sql)


def split_statements(sql: str) -> list[str]:
    """Split on top-level `;`, ignoring ones inside quotes and comments."""
    out, buf, i, n = [], [], 0, len(sql)
    quote: str | None = None
    while i < n:
        ch = sql[i]
        if quote:
            buf.append(ch)
            if ch == "\\" and i + 1 < n:
                buf.append(sql[i + 1]); i += 2; continue
            if ch == quote:
                quote = None
        elif ch in ("'", '"', "`"):
            quote = ch; buf.append(ch)
        elif sql.startswith("--", i):
            j = sql.find("\n", i)
            i = n if j < 0 else j
            continue
        elif sql.startswith("/*", i):
            j = sql.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        elif ch == ";":
            stmt = "".join(buf).strip()
            if stmt:
                out.append(stmt)
            buf = []
        else:
            buf.append(ch)
        i += 1
    tail = "".join(buf).strip()
    if tail:
        out.append(tail)
    return out


def q(ident: str) -> str:
    return "`" + ident.replace("`", "``") + "`"


def fq(*parts: str) -> str:
    return ".".join(q(p) for p in parts)


# --------------------------------------------------------------------------- settings
def group_defaults(app: str) -> dict:
    base = "aimapper" if app == "aimapper" else app
    return {"admin_group": f"{base}-admins", "editor_group": f"{base}-editors", "viewer_group": f"{base}-viewers"}


def state_path(app: str) -> Path:
    return STATE_DIR / f"{app}.json"


def load_state(app: str) -> dict:
    p = state_path(app)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except json.JSONDecodeError:
        warn(f"{p} is not valid JSON — ignoring saved settings.")
        return {}


def save_state(app: str, st: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    state_path(app).write_text(json.dumps(st, indent=2) + "\n")


class Ctx:
    """Resolved settings + clients for one run."""

    def __init__(self, args: argparse.Namespace, need_catalog: bool = True):
        self.args = args
        self.app = args.app_name
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,25}", self.app):
            raise InstallError(f"Invalid --app-name '{self.app}'.", "Use ≤26 lowercase letters, numbers and hyphens.")
        self.saved = load_state(self.app)
        s = self.saved.get("settings", {})
        pick = lambda name, default=None: getattr(args, name, None) or s.get(name) or default  # noqa: E731
        self.profile = pick("profile")
        if not self.profile:
            raise InstallError("No --profile given.", "Pass --profile <name> (see `databricks auth profiles`).")
        self.cli = Cli(self.profile, verbose=getattr(args, "verbose", False))
        self.catalog = pick("catalog")
        if need_catalog and not self.catalog:
            raise InstallError("No --catalog given.", "Pass --catalog <catalog> (the Unity Catalog catalog for the app's schema).")
        self.schema = pick("schema", "aimapper")
        self.warehouse = pick("warehouse")
        self.llm = pick("llm", "databricks-claude-sonnet-4-5")
        self.vs_endpoint = pick("vs_endpoint", "aimapper-retrieval")
        gd = group_defaults(self.app)
        self.admin_group = pick("admin_group", gd["admin_group"])
        self.editor_group = pick("editor_group", gd["editor_group"])
        self.viewer_group = pick("viewer_group", gd["viewer_group"])
        self.admins = pick("admins")
        self.warehouse_id: str | None = s.get("warehouse_id")
        self.me: str | None = None
        self.is_admin = False
        self.account_id: str | None = None
        self.indexes_to_drop: list[str] = []
        self._cache_cleared = False

    def groups(self) -> dict:
        return {"admin": self.admin_group, "editor": self.editor_group, "viewer": self.viewer_group}

    def settings(self) -> dict:
        return {"profile": self.profile, "catalog": self.catalog, "schema": self.schema, "warehouse": self.warehouse,
                "warehouse_id": self.warehouse_id, "llm": self.llm, "vs_endpoint": self.vs_endpoint,
                "admin_group": self.admin_group, "editor_group": self.editor_group,
                "viewer_group": self.viewer_group, "admins": self.admins}

    def genie_file(self) -> str:
        return f".databricks/generated/{self.app}.geniespace.json"

    def bundle_vars(self) -> list[str]:
        v = {"app_name": self.app, "catalog": self.catalog, "schema": self.schema,
             "sql_warehouse_id": self.warehouse_id, "serving_endpoint_name": self.llm,
             "admins": self.admins or "", "admin_group": self.admin_group, "editor_group": self.editor_group,
             "viewer_group": self.viewer_group, "vs_endpoint": self.vs_endpoint, "genie_space_file": self.genie_file()}
        out: list[str] = []
        for k, val in v.items():
            out += ["--var", f"{k}={val}"]
        return out

    def bundle(self, *args: str, json_out: bool = False, timeout: int = 1800) -> object:
        # The CLI caches deployment state locally per *target*, not per app. Clear it so
        # every bundle command reads THIS app's state from the workspace — otherwise one
        # install's cached state could make a deploy recreate another install's app.
        # Done once per run (later commands in this run are for the same app), and it keeps
        # the user's variable-overrides.json and the sync snapshots (keyed per remote path).
        cache = LOCAL_BUNDLE_CACHE / "default"
        if not self._cache_cleared and cache.exists():
            for p in cache.iterdir():
                if p.name in ("variable-overrides.json", "sync-snapshots"):
                    continue
                shutil.rmtree(p) if p.is_dir() else p.unlink()
        self._cache_cleared = True
        lockable = args[0] in ("deploy", "destroy") or args[:2] == ("deployment", "bind")
        force = ["--force-lock"] if lockable and getattr(self.args, "force_lock", False) else []
        try:
            return self.cli.run("bundle", *args, *force, *self.bundle_vars(), json_out=json_out, timeout=timeout)
        except InstallError as e:
            m = re.search(r"deploy lock acquired by (\S+) at (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)(?:\.\d+)?(?: ([+-]\d{4}))?",
                          str(e))
            if not (lockable and m and not force):
                raise
            # A run that crashed or timed out mid-deploy leaves its lock behind. Treat a
            # lock older than an hour as stale; otherwise ask before overriding it. The
            # lock time is in the holder's timezone, so only judge it when the offset is known.
            age_min = 0.0
            if m.group(3):
                taken = datetime.strptime(f"{m.group(2)} {m.group(3)}", "%Y-%m-%d %H:%M:%S %z")
                age_min = (datetime.now(timezone.utc) - taken).total_seconds() / 60
            if age_min > 60:
                warn(f"clearing a stale deployment lock from {m.group(2)} ({int(age_min)} min old)")
                return self.cli.run("bundle", *args, "--force-lock", *self.bundle_vars(), json_out=json_out, timeout=timeout)
            raise InstallError(
                f"Another deployment of '{self.app}' holds the lock (taken by {m.group(1)} at {m.group(2)}).",
                "Usually an earlier run was interrupted and left it behind. If no other install of this app is "
                "running right now, re-run with --force-lock.") from None

    def full_name(self, suffix: str) -> str:
        return f"{self.catalog}.{self.schema}.{suffix}"


# --------------------------------------------------------------------------- checks
def check_cli(ctx: Ctx) -> None:
    v = ctx.cli.run("--version", json_out=False, use_profile=False)
    m = re.search(r"(\d+)\.(\d+)\.(\d+)", str(v))
    if not m:
        raise InstallError(f"Couldn't read the Databricks CLI version from: {v}")
    have = tuple(int(x) for x in m.groups())
    if have < MIN_CLI:
        raise InstallError(f"Databricks CLI {'.'.join(map(str, have))} is too old (need ≥ {'.'.join(map(str, MIN_CLI))}).",
                           "Upgrade: https://docs.databricks.com/dev-tools/cli/install.html")
    ok(f"Databricks CLI {'.'.join(map(str, have))}")


def check_auth(ctx: Ctx) -> None:
    me = ctx.cli.run("current-user", "me")
    if not isinstance(me, dict) or not me.get("userName"):
        raise InstallError(f"Couldn't sign in with profile '{ctx.profile}'.",
                           f"Run `databricks auth login --profile {ctx.profile}` and re-run.")
    ctx.me = me["userName"]
    groups = {g.get("display") for g in me.get("groups", [])}
    # Not required: a workspace admin can do the admin-only steps first (see the README).
    # Each step that needs more than the user has then says exactly what to ask for.
    ctx.is_admin = "admins" in groups
    ctx.admins = ctx.admins or ctx.me
    if ctx.is_admin:
        ok(f"Signed in as {ctx.me} (workspace admin)")
    else:
        ok(f"Signed in as {ctx.me}")
        warn(f"not a workspace admin: the role groups and permissions in {NON_ADMIN_README} must already "
             "be set up; each step checks what it needs")
    cfg = ctx.cli.api("get", "/.well-known/databricks-config") or {}
    ctx.account_id = cfg.get("account_id") if isinstance(cfg, dict) else None
    if not ctx.account_id:
        raise InstallError("Couldn't read the workspace's account id.", "Check the profile points at a workspace URL.")


def check_catalog(ctx: Ctx) -> None:
    res = ctx.cli.run("catalogs", "get", ctx.catalog, check=False)
    if ctx.cli.missing(res):
        raise InstallError(f"Catalog '{ctx.catalog}' doesn't exist (or you can't see it).",
                           "Create it first, or pass an existing --catalog you have USE CATALOG + CREATE SCHEMA on.")
    if ctx.cli.failed(res):
        raise InstallError(f"Couldn't read catalog '{ctx.catalog}': {ctx.cli.failed(res)}", hint_for(ctx.cli.failed(res) or ""))
    ok(f"Catalog {ctx.catalog}")


def check_warehouse(ctx: Ctx) -> None:
    whs = ctx.cli.run("warehouses", "list") or []
    want = ctx.warehouse or ctx.warehouse_id
    chosen = None
    if want:
        chosen = next((w for w in whs if w.get("id") == want or w.get("name") == want), None)
        if not chosen:
            names = ", ".join(sorted(w.get("name", "") for w in whs)[:10])
            raise InstallError(f"SQL warehouse '{want}' not found.", f"Pass --warehouse <name or id>. Available: {names}")
    else:
        serverless = [w for w in whs if w.get("enable_serverless_compute")]
        chosen = (serverless or whs or [None])[0]
        if not chosen:
            raise InstallError("No SQL warehouse found.", "Create a serverless SQL warehouse, then re-run with --warehouse.")
    if not chosen.get("enable_serverless_compute") and (chosen.get("warehouse_type") or "").upper() != "PRO":
        warn(f"Warehouse '{chosen.get('name')}' is not serverless/pro — document parsing (ai_parse_document) may not work.")
    ctx.warehouse_id = chosen["id"]
    ctx.warehouse = chosen.get("name")
    ok(f"SQL warehouse {chosen.get('name')} ({chosen['id']})")


def check_endpoints(ctx: Ctx) -> None:
    for name, why in ((ctx.llm, "the mapping LLM (--llm)"), (EMBEDDING_ENDPOINT, "embeddings for both search indexes")):
        res = ctx.cli.run("serving-endpoints", "get", name, check=False)
        if ctx.cli.missing(res):
            raise InstallError(f"Serving endpoint '{name}' ({why}) doesn't exist in this workspace.",
                               "Pass another --llm, or enable Foundation Model APIs for this workspace.")
        if ctx.cli.failed(res):
            raise InstallError(f"Couldn't read serving endpoint '{name}': {ctx.cli.failed(res)}", hint_for(ctx.cli.failed(res) or ""))
    ok(f"Serving endpoints {ctx.llm}, {EMBEDDING_ENDPOINT}")


def check_scim(ctx: Ctx) -> None:
    res = ctx.cli.api("get", "/api/2.0/account/scim/v2/Groups", {"count": "1", "attributes": "id"}, check=False)
    if ctx.cli.failed(res):
        raise InstallError(f"Can't reach account groups from this workspace: {ctx.cli.failed(res)[:300]}",
                           "Role groups are account groups; the workspace must use identity federation and you must "
                           f"be allowed to read groups. If you aren't a workspace admin, see {NON_ADMIN_README}.")
    ok("Account groups reachable")


def preflight(ctx: Ctx) -> None:
    check_cli(ctx)
    check_auth(ctx)
    check_catalog(ctx)
    check_warehouse(ctx)
    check_endpoints(ctx)
    check_scim(ctx)


# --------------------------------------------------------------------------- discovery
def find_group(ctx: Ctx, name: str) -> str | None:
    r = ctx.cli.api("get", "/api/2.0/account/scim/v2/Groups",
                    {"filter": f'displayName eq "{name}"', "attributes": "id,displayName"}) or {}
    hits = r.get("Resources") or [] if isinstance(r, dict) else []
    return hits[0]["id"] if hits else None


def find_app(ctx: Ctx) -> dict | None:
    res = ctx.cli.run("apps", "get", ctx.app, check=False)
    if ctx.cli.missing(res):
        return None
    if ctx.cli.failed(res):
        raise InstallError(f"Couldn't check app '{ctx.app}': {ctx.cli.failed(res)}", hint_for(ctx.cli.failed(res) or ""))
    return res if isinstance(res, dict) else None


def find_job(ctx: Ctx) -> str | None:
    jobs = ctx.cli.run("jobs", "list", "--name", f"{ctx.app}-retrieval-sync") or []
    return str(jobs[0]["job_id"]) if jobs else None


def find_genie(ctx: Ctx) -> str | None:
    title = f"{ctx.app}-assistant"
    token = None
    for _ in range(50):
        args = ["genie", "list-spaces", "--page-size", "100"] + (["--page-token", token] if token else [])
        res = ctx.cli.run(*args) or {}
        for sp in res.get("spaces", []) if isinstance(res, dict) else []:
            if sp.get("title") == title:
                return sp.get("space_id")
        token = res.get("next_page_token") if isinstance(res, dict) else None
        if not token:
            return None
    return None


def find_index(ctx: Ctx, key: str) -> dict | None:
    res = ctx.cli.run("vector-search-indexes", "get-index", ctx.full_name(INDEXES[key][0]), check=False)
    if ctx.cli.missing(res):
        return None
    if ctx.cli.failed(res):
        raise InstallError(f"Couldn't check index {ctx.full_name(INDEXES[key][0])}: {ctx.cli.failed(res)}",
                           hint_for(ctx.cli.failed(res) or ""))
    return res if isinstance(res, dict) else None


def index_differences(ctx: Ctx, key: str, idx: dict) -> list[str]:
    _, table, pk, embed_col, cols = INDEXES[key]
    spec = idx.get("delta_sync_index_spec") or {}
    diffs = []
    if idx.get("endpoint_name") != ctx.vs_endpoint:
        diffs.append(f"endpoint is {idx.get('endpoint_name')}, expected {ctx.vs_endpoint}")
    if idx.get("primary_key") != pk:
        diffs.append(f"primary key is {idx.get('primary_key')}, expected {pk}")
    if spec.get("source_table") != ctx.full_name(table):
        diffs.append(f"source table is {spec.get('source_table')}, expected {ctx.full_name(table)}")
    emb = (spec.get("embedding_source_columns") or [{}])[0]
    if emb.get("name") != embed_col or emb.get("embedding_model_endpoint_name") != EMBEDDING_ENDPOINT:
        diffs.append(f"embeds {emb.get('name')} with {emb.get('embedding_model_endpoint_name')}, "
                     f"expected {embed_col} with {EMBEDDING_ENDPOINT}")
    if set(spec.get("columns_to_sync") or []) != set(cols):
        diffs.append("synced columns differ")
    return diffs


def bundle_state_ids(ctx: Ctx) -> dict:
    """Resource key → id for resources already in THIS app's bundle state."""
    try:
        summary = ctx.bundle("summary", json_out=True, timeout=300) or {}
    except InstallError:
        return {}
    out = {}
    for kind, items in ((summary.get("resources") or {}) if isinstance(summary, dict) else {}).items():
        for key, res in (items or {}).items():
            if isinstance(res, dict) and (res.get("id") or res.get("modified_status") != "created"):
                if res.get("id"):
                    out[key] = str(res["id"])
    return out


# --------------------------------------------------------------------------- steps
def step_groups(ctx: Ctx, dry: bool) -> None:
    for role, name in ctx.groups().items():
        gid = find_group(ctx, name)
        if gid:
            ok(f"{name}: exists")
        elif not ctx.is_admin:
            msg = f"{name} doesn't exist, and creating account groups needs a workspace admin."
            if dry:
                warn(msg)
                continue
            raise InstallError(msg, f"Ask a workspace admin to create the three role groups (step 1 in {NON_ADMIN_README}), "
                                    "or pass existing groups with --admin-group / --editor-group / --viewer-group.")
        elif dry:
            warn(f"{name}: would be created")
            continue
        else:
            res = ctx.cli.api("post", "/api/2.0/account/scim/v2/Groups", body={"schemas": [SCIM_GROUP], "displayName": name}) or {}
            gid = res.get("id")
            if not gid:
                raise InstallError(f"Creating group {name} returned no id.")
            ok(f"{name}: created")
        # Adding the group to the workspace needs a workspace admin; for anyone else it's
        # part of the admin's one-time setup (README step 1).
        if not dry and ctx.is_admin:
            ctx.cli.api("put", f"/api/2.0/preview/permissionassignments/principals/{gid}", body={"permissions": ["USER"]})


def schema_is_fresh(ctx: Ctx, sql: Sql) -> bool:
    try:
        rows = sql.run(f"SELECT count(*) AS n FROM {fq(ctx.catalog, ctx.schema, 'target_schema')}")
        # An empty target schema only counts as fresh if this install never ran the table
        # step before — otherwise the user emptied it on purpose; leave it alone.
        return int(rows[0]["n"]) == 0 and "Schema, tables, volume and seed data" not in ctx.saved.get("steps", {})
    except InstallError as e:
        if "TABLE_OR_VIEW_NOT_FOUND" in str(e) or "SCHEMA_NOT_FOUND" in str(e) or "does not exist" in str(e).lower():
            return True
        raise


def step_tables(ctx: Ctx, sql: Sql, dry: bool) -> None:
    fresh = schema_is_fresh(ctx, sql)
    a = ctx.args
    seed = fresh or a.reseed_target_schema
    sample = (fresh and not a.no_sample_data) or a.sample_data
    say(f"      schema {ctx.catalog}.{ctx.schema}: {'new/empty — will seed' if fresh else 'has data — existing rows kept'}")
    sample_schema_existed = False
    if sample and not dry:
        try:
            sample_schema_existed = bool(sql.run(f"SHOW SCHEMAS IN {q(ctx.catalog)} LIKE '{ctx.schema}_source'"))
        except InstallError:
            sample_schema_existed = True  # unknown → never claim we created it
    for fname in SQL_FILES:
        if fname in SEED_FILES and not seed:
            ok(f"{fname}: skipped (target schema already has data; --reseed-target-schema to reset)")
            continue
        if fname in SAMPLE_FILES and not sample:
            ok(f"{fname}: skipped (demo source data; --sample-data to (re)create)")
            continue
        stmts = [s for s in split_statements(substitute((SETUP / fname).read_text(), ctx.catalog, ctx.schema))
                 if not re.match(r"(?i)\s*USE\s+(CATALOG|SCHEMA)\b", s)]
        if dry:
            warn(f"{fname}: would run {len(stmts)} statement(s)")
            continue
        for stmt in stmts:
            namespace = re.match(r"(?i)\s*CREATE\s+(CATALOG|SCHEMA)\b", stmt)
            if re.match(r"(?i)\s*CREATE\s+CATALOG\b", stmt):
                continue  # the catalog was checked in preflight; creating one needs metastore admin
            try:
                sql.run(stmt, None if namespace else ctx.catalog, None if namespace else ctx.schema)
            except InstallError as e:
                raise InstallError(f"{fname}: {e}", e.hint) from None
        ok(f"{fname}: {len(stmts)} statement(s)")
    if dry:
        return
    # Only record the demo schema as ours (so uninstall --delete-data may drop it) if this
    # run actually created it — never a pre-existing schema of the same name.
    created = ctx.saved.setdefault("created", {})
    created["sample_schema"] = bool(created.get("sample_schema")) or (sample and not sample_schema_existed)


def uc_plan(ctx: Ctx) -> list[tuple[str, str, str]]:
    """(privilege, securable, group) — mirrors planGrants() in server/aimapper/permissions.ts."""
    sch = fq(ctx.catalog, ctx.schema)
    out = []
    for role, g in ctx.groups().items():
        out.append(("USE CATALOG", f"CATALOG {q(ctx.catalog)}", g))
        if role == "admin":
            out += [("ALL PRIVILEGES", f"SCHEMA {sch}", g), ("MANAGE", f"SCHEMA {sch}", g)]
            continue
        out += [("USE SCHEMA", f"SCHEMA {sch}", g), ("SELECT", f"SCHEMA {sch}", g), ("READ VOLUME", f"SCHEMA {sch}", g)]
        for t in (EDITOR_WRITE_TABLES if role == "editor" else VIEWER_WRITE_TABLES):
            out.append(("MODIFY", f"TABLE {fq(ctx.catalog, ctx.schema, t)}", g))
        if role == "editor":
            out.append(("WRITE VOLUME", f"VOLUME {fq(ctx.catalog, ctx.schema, 'reference_docs')}", g))
    return out


def step_uc_grants(ctx: Ctx, sql: Sql, dry: bool) -> None:
    plan = uc_plan(ctx)
    sample_schema = f"{ctx.schema}_source"
    try:
        has_sample = bool(sql.run(f"SHOW SCHEMAS IN {q(ctx.catalog)} LIKE '{sample_schema}'"))
    except InstallError:
        has_sample = False
    if has_sample:  # demo source data: every role can read it
        for g in ctx.groups().values():
            plan += [("USE SCHEMA", f"SCHEMA {fq(ctx.catalog, sample_schema)}", g),
                     ("SELECT", f"SCHEMA {fq(ctx.catalog, sample_schema)}", g)]
    if dry:
        warn(f"would apply {len(plan)} Unity Catalog grants to the three groups")
        return
    for priv, securable, g in plan:
        sql.run(f"GRANT {priv} ON {securable} TO {q(g)}")
    ok(f"{len(plan)} Unity Catalog grants (idempotent)")


def patch_acl(ctx: Ctx, obj: str, levels: dict, what: str | None = None) -> None:
    acl = [{"group_name": g, "permission_level": lvl} for g, lvl in levels.items()]
    try:
        ctx.cli.api("patch", f"/api/2.0/permissions/{obj}", body={"access_control_list": acl})
    except InstallError as e:
        if ctx.is_admin or not what:
            raise
        raise InstallError(f"Couldn't give the role groups access to {what}: {e}",
                           f"Sharing it needs CAN MANAGE on it. Ask a workspace admin to grant you that (step 4 in "
                           f"{NON_ADMIN_README}), and check the three groups were added to this workspace (step 1).") from None


def remove_groups_from_acl(ctx: Ctx, obj: str, groups: set[str]) -> None:
    """Drop the groups' direct entries from an object's permissions, keeping every other
    entry (PATCH can't remove, so GET the ACL and PUT it back without them)."""
    cur = ctx.cli.api("get", f"/api/2.0/permissions/{obj}") or {}
    keep = []
    for e in cur.get("access_control_list", []) if isinstance(cur, dict) else []:
        if e.get("group_name") in groups:
            continue
        who = {k: e[k] for k in ("user_name", "group_name", "service_principal_name") if e.get(k)}
        for perm in e.get("all_permissions", []):
            if who and not perm.get("inherited") and perm.get("permission_level"):
                keep.append({**who, "permission_level": perm["permission_level"]})
    ctx.cli.api("put", f"/api/2.0/permissions/{obj}", body={"access_control_list": keep})


def step_vs_endpoint(ctx: Ctx, dry: bool) -> None:
    res = ctx.cli.run("vector-search-endpoints", "get-endpoint", ctx.vs_endpoint, check=False)
    if ctx.cli.failed(res) and not ctx.cli.missing(res):
        raise InstallError(f"Couldn't check Vector Search endpoint: {ctx.cli.failed(res)}", hint_for(ctx.cli.failed(res) or ""))
    if ctx.cli.missing(res):
        if dry:
            warn(f"{ctx.vs_endpoint}: would be created (Storage-Optimized; takes ~5–15 min)")
            return
        say(f"      creating {ctx.vs_endpoint} (Storage-Optimized) — this can take 5–15 minutes…")
        try:
            ctx.cli.run("vector-search-endpoints", "create-endpoint", ctx.vs_endpoint, "STORAGE_OPTIMIZED", "--no-wait")
        except InstallError as e:
            if ctx.is_admin:
                raise
            raise InstallError(f"Couldn't create Vector Search endpoint {ctx.vs_endpoint}: {e}",
                               f"Ask a workspace admin to create it and grant you CAN MANAGE (step 4 in {NON_ADMIN_README}), "
                               "or pass an endpoint you manage with --vs-endpoint.") from None
        ctx.saved.setdefault("created", {})["vs_endpoint"] = True
    deadline = time.time() + 30 * 60
    while True:
        ep = ctx.cli.run("vector-search-endpoints", "get-endpoint", ctx.vs_endpoint) or {}
        st = ((ep.get("endpoint_status") or {}).get("state") or "").upper()
        if st == "ONLINE":
            break
        if st in ("OFFLINE", "FAILED") or "FAIL" in st:
            raise InstallError(f"Vector Search endpoint {ctx.vs_endpoint} is {st}: {(ep.get('endpoint_status') or {}).get('message', '')}",
                               "Check it in Compute → Vector Search, or delete it and re-run.")
        if dry:
            warn(f"{ctx.vs_endpoint}: exists, state {st or 'unknown'}")
            return
        if time.time() > deadline:
            raise InstallError(f"Vector Search endpoint still {st} after 30 minutes.", "Re-run later — the installer picks up where it stopped.")
        time.sleep(20)
    ok(f"{ctx.vs_endpoint}: online")
    if not dry:
        patch_acl(ctx, f"vector-search-endpoints/{ep['id']}",
                  {ctx.admin_group: "CAN_MANAGE", ctx.editor_group: "CAN_USE", ctx.viewer_group: "CAN_USE"},
                  f"Vector Search endpoint {ctx.vs_endpoint}")
        ok("groups can use the endpoint")


def step_warehouse_acl(ctx: Ctx, dry: bool) -> None:
    levels = {ctx.admin_group: "CAN_MANAGE", ctx.editor_group: "CAN_USE", ctx.viewer_group: "CAN_USE"}
    if dry:
        warn(f"would grant the groups access to warehouse {ctx.warehouse}")
        return
    patch_acl(ctx, f"warehouses/{ctx.warehouse_id}", levels, f"SQL warehouse {ctx.warehouse}")
    ok(f"groups can use warehouse {ctx.warehouse}")


def step_genie_file(ctx: Ctx) -> None:
    text = (SETUP / "templates" / "genie_space.template.json").read_text()
    esc = lambda s: json.dumps(s)[1:-1]  # noqa: E731 — keep the JSON valid for any name
    text = text.replace("{{CATALOG}}", esc(ctx.catalog)).replace("{{SCHEMA}}", esc(ctx.schema))
    json.loads(text)  # fail early on a broken template
    GENERATED_DIR.mkdir(parents=True, exist_ok=True)
    (ROOT / ctx.genie_file()).write_text(text)
    ok(f"Genie space definition for {ctx.catalog}.{ctx.schema}")


def step_bind(ctx: Ctx, dry: bool) -> None:
    """Adopt resources that already exist in the workspace into this app's bundle state,
    so the deploy updates them instead of failing on "already exists" or duplicating."""
    in_state = bundle_state_ids(ctx)
    found: dict[str, str | None] = {}
    app = find_app(ctx)
    found["app"] = ctx.app if app else None
    found["retrieval_sync"] = find_job(ctx)
    found["assistant"] = find_genie(ctx)
    for key in INDEXES:
        idx = find_index(ctx, key)
        if idx is None:
            found[key] = None
            continue
        diffs = index_differences(ctx, key, idx)
        name = ctx.full_name(INDEXES[key][0])
        if diffs and not ctx.args.recreate_indexes:
            raise InstallError(f"Index {name} exists but doesn't match what the app expects: " + "; ".join(diffs) + ".",
                               "Re-run with --recreate-indexes to drop and rebuild it (re-embeds every row; searches "
                               "return nothing until it finishes), or point --schema at another schema.")
        if diffs:
            # Dropped in step_deploy, only after the plan guard has passed.
            warn(f"{name}: will be dropped and rebuilt (--recreate-indexes)")
            ctx.indexes_to_drop.append(name)
            found[key] = None
            continue
        found[key] = name
    for key, rid in found.items():
        if not rid:
            say(f"      {key}: will be created")
        elif key in in_state:
            ok(f"{key}: already managed by this install")
        elif dry:
            warn(f"{key}: exists ({rid}) — would be adopted, not re-created")
        else:
            ctx.bundle("deployment", "bind", key, rid, "--auto-approve", timeout=600)
            ok(f"{key}: existing resource adopted ({rid})")


def step_plan_guard(ctx: Ctx, dry: bool) -> None:
    """Refuse to deploy if the bundle would delete or re-create the app or an index."""
    plan = ctx.bundle("plan", json_out=True, timeout=900) or {}
    if dry:
        say("      (dry run: shown before existing resources are adopted — adopted ones become updates)")
    risky = []
    for key, entry in (plan.get("plan") or {}).items() if isinstance(plan, dict) else []:
        action = (entry or {}).get("action")
        say(f"      {key}: {action}")
        if action in ("delete", "recreate") and (".apps." in key or ".vector_search_indexes." in key) and not key.endswith(".permissions"):
            if ".vector_search_indexes." in key and ctx.args.recreate_indexes:
                continue
            risky.append(f"{key} → {action}")
    if risky:
        raise InstallError("The deploy would delete or re-create: " + ", ".join(risky) + ". Stopped to protect it.",
                           "This usually means the app/index exists under a different configuration. Check the names "
                           "you passed; use --recreate-indexes only if rebuilding indexes is intended.")
    ok("no app or index would be deleted or re-created")


def drop_index_and_wait(ctx: Ctx, name: str) -> None:
    """Delete an index and wait until it's gone (deletion is async; re-creating the
    same name too early fails with "already exists")."""
    ctx.cli.run("vector-search-indexes", "delete-index", name, json_out=False)
    deadline = time.time() + 15 * 60
    while not ctx.cli.missing(ctx.cli.run("vector-search-indexes", "get-index", name, check=False)):
        if time.time() > deadline:
            raise InstallError(f"Index {name} is still being deleted after 15 minutes.", "Re-run later.")
        time.sleep(10)
    ok(f"{name}: dropped for rebuild (--recreate-indexes)")


def step_deploy(ctx: Ctx) -> None:
    for name in ctx.indexes_to_drop:
        drop_index_and_wait(ctx, name)
    ctx.indexes_to_drop.clear()
    # The Genie space is placed in the bundle's resource folder, which the CLI does not
    # create; without it, creating or updating (moving) the space fails with 404.
    resource_path = ((ctx.bundle("validate", json_out=True) or {}).get("workspace") or {}).get("resource_path")
    if resource_path:
        ctx.cli.run("workspace", "mkdirs", resource_path, json_out=False)
    ctx.bundle("deploy", "--auto-approve", timeout=2400)
    # Remember who owns the deployment state (it lives under the deployer's home).
    ctx.saved["deployed_by"] = ctx.me
    ok("bundle deployed (app, Genie space, search indexes, sync job)")
    say("      deploying app code and starting it — usually 2–5 minutes…")
    ctx.bundle("run", "app", timeout=2400)
    ok("app code deployed and started")


def step_sp_and_admin(ctx: Ctx, dry: bool) -> None:
    app = find_app(ctx)
    sp = (app or {}).get("service_principal_client_id")
    if dry:
        warn("would make the app's service principal a manager of the three groups and add the first admin")
        return
    if not sp:
        raise InstallError("The app has no service principal yet.", "Wait a minute for the app to finish creating, then re-run.")
    # A non-admin can only do this as a manager of the groups (README step 2). Otherwise
    # it's left to an admin after the install (README step 3) — the app works, but
    # Admin → Roles can't change membership until then, so warn rather than fail.
    pending: list[str] = []
    for name in ctx.groups().values():
        try:
            gid = find_group(ctx, name)
            rs_name = f"accounts/{ctx.account_id}/groups/{gid}/ruleSets/default"
            rs = ctx.cli.api("get", "/api/2.0/preview/accounts/access-control/rule-sets", {"name": rs_name, "etag": ""}) or {}
            rules = rs.get("grant_rules") or []
            ref = f"servicePrincipals/{sp}"
            mgr = next((r for r in rules if r.get("role") == "roles/group.manager"), None)
            if mgr and ref in (mgr.get("principals") or []):
                continue
            if mgr:
                mgr["principals"] = [*mgr.get("principals", []), ref]
            else:
                rules.append({"role": "roles/group.manager", "principals": [ref]})
            ctx.cli.api("put", "/api/2.0/preview/accounts/access-control/rule-sets",
                        body={"name": rs_name, "rule_set": {"name": rs_name, "etag": rs.get("etag", ""), "grant_rules": rules}})
        except InstallError:
            if ctx.is_admin:
                raise
            pending.append(name)
    if pending:
        warn(f"couldn't make the app's service principal ({sp}) a manager of {', '.join(pending)} (this needs "
             f"a workspace admin or a manager of the group). Ask a workspace admin to grant it Group: Manager "
             f"(step 3 in {NON_ADMIN_README}); until then Admin → Roles can't add people.")
    else:
        ok("app service principal manages the role groups")
    first = (ctx.admins or "").split(",")[0].strip()
    if first and pending and ctx.admin_group in pending:
        warn(f"skipped adding {first} to {ctx.admin_group} (needs a group manager); bootstrap admins are app admins anyway.")
    elif first:
        try:
            add_first_admin(ctx, first)
        except InstallError:
            if ctx.is_admin:
                raise
            warn(f"couldn't add {first} to {ctx.admin_group} (needs a group manager); bootstrap admins are app admins anyway.")


def add_first_admin(ctx: Ctx, first: str) -> None:
    users = (ctx.cli.api("get", "/api/2.0/account/scim/v2/Users",
                         {"filter": f'userName eq "{first}"', "attributes": "id"}) or {}).get("Resources") or []
    if not users:
        warn(f"{first} isn't an account user — add an admin in Admin → Roles later.")
        return
    gid = find_group(ctx, ctx.admin_group)
    members = (ctx.cli.api("get", f"/api/2.0/account/scim/v2/Groups/{gid}", {"attributes": "members"}) or {}).get("members") or []
    if not any(m.get("value") == users[0]["id"] for m in members):
        ctx.cli.api("patch", f"/api/2.0/account/scim/v2/Groups/{gid}",
                    body={"schemas": [SCIM_PATCH], "Operations": [{"op": "add", "path": "members", "value": [{"value": users[0]["id"]}]}]})
    ok(f"{first} is in {ctx.admin_group}")


def step_sync_indexes(ctx: Ctx) -> None:
    for key in INDEXES:
        name = ctx.full_name(INDEXES[key][0])
        res = ctx.cli.run("vector-search-indexes", "sync-index", name, json_out=False, check=False)
        if ctx.cli.failed(res):
            warn(f"{name}: sync not started yet ({ctx.cli.failed(res)[:120]}) — the hourly job will sync it.")
        else:
            ok(f"{name}: sync started")


# --------------------------------------------------------------------------- commands
def run_steps(ctx: Ctx, steps: list, resume_cmd: str, persist: bool = True) -> int:
    total = len(steps)
    for i, (title, fn) in enumerate(steps, 1):
        say(f"\n[{i}/{total}] {title}")
        try:
            fn()
        except InstallError as e:
            say(f"\n✗ Step {i}/{total} ({title}) failed:\n  {e}")
            if e.hint:
                say(f"\n  How to fix: {e.hint}")
            say(f"\n  After fixing it, re-run:\n    {resume_cmd}\n  Finished steps are re-checked and skipped; nothing is duplicated.")
            return 1
        except KeyboardInterrupt:
            say(f"\n✗ Interrupted during step {i}/{total} ({title}).\n  Re-run to continue:\n    {resume_cmd}")
            return 130
        if not persist:  # dry runs (status) must not change the saved install
            continue
        ctx.saved.setdefault("steps", {})[title] = time.strftime("%Y-%m-%dT%H:%M:%S")
        ctx.saved["settings"] = ctx.settings()
        save_state(ctx.app, ctx.saved)
    return 0


def resume_command(ctx: Ctx, cmd: str) -> str:
    return f"python3 setup/install.py {cmd} --profile {ctx.profile} --app-name {ctx.app}"


def cmd_install(args: argparse.Namespace, dry: bool = False) -> int:
    ctx = Ctx(args)
    say(f"{'Checking' if dry else 'Installing'} AI Mapper '{ctx.app}' → {ctx.catalog}.{ctx.schema} (profile {ctx.profile})"
        + ("\n(dry run: nothing will be changed)" if dry else ""))
    sql_holder: dict = {}

    def sql() -> Sql:
        if "sql" not in sql_holder:
            sql_holder["sql"] = Sql(ctx.cli, ctx.warehouse_id or "")
        return sql_holder["sql"]

    steps = [
        ("Check prerequisites", lambda: preflight(ctx)),
        ("Role groups", lambda: step_groups(ctx, dry)),
        ("Schema, tables, volume and seed data", lambda: step_tables(ctx, sql(), dry)),
        ("Unity Catalog grants for the groups", lambda: step_uc_grants(ctx, sql(), dry)),
        ("Vector Search endpoint", lambda: step_vs_endpoint(ctx, dry)),
        ("SQL warehouse access for the groups", lambda: step_warehouse_acl(ctx, dry)),
        ("Genie space definition", lambda: step_genie_file(ctx)),
        ("Adopt existing app resources", lambda: step_bind(ctx, dry)),
        ("Check the deployment plan", lambda: step_plan_guard(ctx, dry)),
    ]
    if not dry:
        steps += [
            ("Deploy the app and its resources", lambda: step_deploy(ctx)),
            ("Role-group managers and first admin", lambda: step_sp_and_admin(ctx, dry)),
            ("Start index syncs", lambda: step_sync_indexes(ctx)),
        ]
    rc = run_steps(ctx, steps, resume_command(ctx, "status" if dry else "install"), persist=not dry)
    if rc:
        return rc
    if dry:
        say("\nDry run complete — run `install` (same options) to apply.")
        return 0
    app = find_app(ctx) or {}
    say(f"\n✓ AI Mapper '{ctx.app}' is installed.\n  Open: {app.get('url', '(see Compute → Apps)')}\n"
        f"  Next: Admin → Roles → assign people to roles. Upload reference PDFs in References.\n"
        f"  Redeploy code later with: {resume_command(ctx, 'deploy')}")
    return 0


def cmd_deploy(args: argparse.Namespace) -> int:
    ctx = Ctx(args)
    if not ctx.saved:
        raise InstallError(f"No saved install for '{ctx.app}'.", "Run `install` first.")
    steps = [("Check prerequisites", lambda: (check_cli(ctx), check_auth(ctx), check_warehouse(ctx))),
             ("Genie space definition", lambda: step_genie_file(ctx)),
             ("Check the deployment plan", lambda: step_plan_guard(ctx, False)),
             ("Deploy the app and its resources", lambda: step_deploy(ctx))]
    return run_steps(ctx, steps, resume_command(ctx, "deploy"))


def cmd_uninstall(args: argparse.Namespace) -> int:
    ctx = Ctx(args, need_catalog=False)
    if args.all:
        args.delete_data = args.delete_groups = args.delete_endpoint = True
    check_cli(ctx)
    check_auth(ctx)
    me = ctx.me
    app = find_app(ctx)
    job = find_job(ctx)
    genie = find_genie(ctx)
    idx = {k: find_index(ctx, k) for k in INDEXES} if ctx.catalog else {}
    groups = {n: find_group(ctx, n) for n in ctx.groups().values()} if args.delete_groups else {}
    plan: list[tuple[str, object]] = []
    if app:
        plan.append((f"App {ctx.app}", lambda: ctx.cli.run("apps", "delete", ctx.app, json_out=False)))
    if job:
        plan.append((f"Job {ctx.app}-retrieval-sync ({job})", lambda: ctx.cli.run("jobs", "delete", job, json_out=False)))
    if genie:
        plan.append((f"Genie space {ctx.app}-assistant ({genie})", lambda: ctx.cli.run("genie", "trash-space", genie, json_out=False)))
    for key, i in idx.items():
        if i:
            name = i["name"]
            plan.append((f"Vector Search index {name}", lambda n=name: ctx.cli.run("vector-search-indexes", "delete-index", n, json_out=False)))
    if not ctx.catalog:
        warn("No --catalog (and no saved install): the search indexes can't be located and will NOT be removed. "
             "Pass --catalog to remove them too.")
    # Deployment state lives under the home of whoever deployed, not whoever uninstalls.
    owner = ctx.saved.get("deployed_by") or me
    state_dir = f"/Workspace/Users/{owner}/.bundle/aimapper/{ctx.app}"
    plan.append((f"Bundle deployment state {state_dir}",
                 lambda: ctx.cli.run("workspace", "delete", state_dir, "--recursive", json_out=False, check=False)))
    if args.delete_data:
        if not ctx.catalog or not ctx.warehouse_id and not ctx.warehouse:
            raise InstallError("--delete-data needs --catalog and --warehouse (or a saved install).")
        if not ctx.warehouse_id:
            check_warehouse(ctx)
        sql = Sql(ctx.cli, ctx.warehouse_id or "")
        try:
            looks_like_app = bool(sql.run(f"SHOW TABLES IN {fq(ctx.catalog, ctx.schema)} LIKE 'aimapper_conversion_runs'"))
        except InstallError:
            looks_like_app = False
        if looks_like_app:
            plan.append((f"Schema {ctx.catalog}.{ctx.schema} — ALL tables, mappings, history and uploaded documents",
                         lambda: sql.run(f"DROP SCHEMA IF EXISTS {fq(ctx.catalog, ctx.schema)} CASCADE")))
            if ctx.saved.get("created", {}).get("sample_schema"):
                plan.append((f"Demo source schema {ctx.catalog}.{ctx.schema}_source",
                             lambda: sql.run(f"DROP SCHEMA IF EXISTS {fq(ctx.catalog, ctx.schema + '_source')} CASCADE")))
        else:
            warn(f"{ctx.catalog}.{ctx.schema} doesn't look like an AI Mapper schema — not dropping it.")
    if args.delete_groups:
        # Remove what the installer granted the groups OUTSIDE the app's schema first, so
        # no grants to deleted groups are left behind on shared objects.
        names = set(ctx.groups().values())
        if ctx.warehouse_id:
            plan.append((f"Role groups' access to SQL warehouse {ctx.warehouse or ctx.warehouse_id}",
                         lambda: remove_groups_from_acl(ctx, f"warehouses/{ctx.warehouse_id}", names)))
        # The endpoint may be shared, so it can outlive --delete-endpoint.
        def endpoint_acl() -> None:
            ep = ctx.cli.run("vector-search-endpoints", "get-endpoint", ctx.vs_endpoint, check=False)
            if isinstance(ep, dict) and ep.get("id"):
                remove_groups_from_acl(ctx, f"vector-search-endpoints/{ep['id']}", names)
        plan.append((f"Role groups' access to Vector Search endpoint {ctx.vs_endpoint}", endpoint_acl))
        if ctx.catalog and ctx.warehouse_id:
            def revoke_catalog() -> None:
                rsql = Sql(ctx.cli, ctx.warehouse_id or "")
                for g in names:
                    rsql.run(f"REVOKE USE CATALOG ON CATALOG {q(ctx.catalog)} FROM {q(g)}")
            plan.append((f"Role groups' USE CATALOG grant on {ctx.catalog}", revoke_catalog))
    for name, gid in groups.items():
        if gid:
            plan.append((f"Account group {name}", lambda g=gid: ctx.cli.api("delete", f"/api/2.0/account/scim/v2/Groups/{g}")))

    if args.delete_endpoint:
        def drop_endpoint() -> str | None:
            left = ctx.cli.run("vector-search-indexes", "list-indexes", ctx.vs_endpoint, check=False) or []
            if isinstance(left, list) and left:
                return f"kept Vector Search endpoint {ctx.vs_endpoint}: {len(left)} other index(es) still use it"
            ctx.cli.run("vector-search-endpoints", "delete-endpoint", ctx.vs_endpoint, json_out=False)
            return None
        plan.append((f"Vector Search endpoint {ctx.vs_endpoint} (only if no other index uses it)", drop_endpoint))

    local_files = [p for p in (state_path(ctx.app), ROOT / ctx.genie_file()) if p.exists()]
    say(f"\nUninstall '{ctx.app}' will remove:")
    for title, _ in plan:
        say(f"  - {title}")
    if local_files:
        say("  - Local install settings: " + ", ".join(str(p.relative_to(ROOT)) for p in local_files)
            + " (last, only if everything else succeeds)")
    kept = [x for x, flag in (("data (schema, tables, documents)", args.delete_data), ("role groups", args.delete_groups),
                              ("Vector Search endpoint", args.delete_endpoint)) if not flag]
    if kept:
        say("Kept: " + ", ".join(kept) + " (use --delete-data / --delete-groups / --delete-endpoint, or --all).")
    if args.dry_run:
        say("\nDry run — nothing removed.")
        return 0
    if not args.yes:
        typed = input(f"\nType the app name ({ctx.app}) to confirm: ").strip()
        if typed != ctx.app:
            say("Not confirmed — nothing removed.")
            return 1
    failures = 0
    for title, fn in plan:
        try:
            note = fn()  # type: ignore[operator]
            ok(note if isinstance(note, str) else f"removed {title}")
        except InstallError as e:
            failures += 1
            say(f"    ✗ {title}: {e}" + (f"\n      How to fix: {e.hint}" if e.hint else ""))
    if not failures:
        for p in local_files:
            p.unlink()
        say(f"\n✓ '{ctx.app}' uninstalled.")
        return 0
    say(f"\n✗ {failures} item(s) couldn't be removed — fix the cause and re-run the same command (removed items are skipped).")
    return 1


# --------------------------------------------------------------------------- CLI args
def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="setup/install.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", required=True)

    def common(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("--profile", help="Databricks CLI profile for the target workspace")
        sp.add_argument("--app-name", default="aimapper", help="App name (default: aimapper)")
        sp.add_argument("--catalog", help="Unity Catalog catalog for the app's schema")
        sp.add_argument("--schema", help="Schema for the app's tables (default: aimapper)")
        sp.add_argument("--warehouse", help="SQL warehouse name or id (default: first serverless warehouse)")
        sp.add_argument("--verbose", action="store_true", help="Print every CLI command")
        sp.add_argument("--force-lock", action="store_true",
                        help="Override a deployment lock left by an interrupted run (only if no other install is running)")

    for name, helptext in (("install", "Install or update the app (safe to re-run)"),
                           ("status", "Read-only check: what exists and what install would do")):
        sp = sub.add_parser(name, help=helptext)
        common(sp)
        sp.add_argument("--llm", help="Chat LLM serving endpoint (default: databricks-claude-sonnet-4-5)")
        sp.add_argument("--admins", help="Bootstrap admin emails, comma-separated (default: you)")
        sp.add_argument("--vs-endpoint", help="Vector Search endpoint name (default: aimapper-retrieval)")
        sp.add_argument("--admin-group"); sp.add_argument("--editor-group"); sp.add_argument("--viewer-group")
        sp.add_argument("--sample-data", action="store_true", help="(Re)create the demo source tables")
        sp.add_argument("--no-sample-data", action="store_true", help="Skip demo source tables on a fresh install")
        sp.add_argument("--reseed-target-schema", action="store_true", help="Reset the target schema to the sample model")
        sp.add_argument("--recreate-indexes", action="store_true", help="Rebuild search indexes that don't match")

    sp = sub.add_parser("deploy", help="Redeploy the app code with the saved settings")
    common(sp)
    sp.add_argument("--recreate-indexes", action="store_true", help=argparse.SUPPRESS)

    sp = sub.add_parser("uninstall", help="Remove the app and its resources")
    common(sp)
    sp.add_argument("--vs-endpoint", help="Vector Search endpoint name (default: saved / aimapper-retrieval)")
    sp.add_argument("--admin-group"); sp.add_argument("--editor-group"); sp.add_argument("--viewer-group")
    sp.add_argument("--delete-data", action="store_true", help="Also DROP the schema (all tables, history, documents)")
    sp.add_argument("--delete-groups", action="store_true", help="Also delete the three role groups")
    sp.add_argument("--delete-endpoint", action="store_true", help="Also delete the Vector Search endpoint if unused")
    sp.add_argument("--all", action="store_true", help="Everything above: a fully clean slate")
    sp.add_argument("--dry-run", action="store_true", help="Show what would be removed")
    sp.add_argument("--yes", action="store_true", help="Don't ask for confirmation")
    return p


def main() -> int:
    if sys.version_info < (3, 9):
        print("Python 3.9+ is required.", file=sys.stderr)
        return 2
    args = parser().parse_args()
    try:
        if args.command == "install":
            return cmd_install(args)
        if args.command == "status":
            return cmd_install(args, dry=True)
        if args.command == "deploy":
            return cmd_deploy(args)
        return cmd_uninstall(args)
    except InstallError as e:
        say(f"\n✗ {e}")
        if e.hint:
            say(f"  How to fix: {e.hint}")
        return 1
    except KeyboardInterrupt:
        say("\n✗ Interrupted. Re-run the same command to continue.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
