# AI Mapper

A Databricks App ([AppKit](https://www.databricks.com/devhub/docs/appkit/v0/), React /
TypeScript) that maps source Unity Catalog tables to a governed **target schema** and
generates validated Databricks SQL. Pick a target entity and a source catalog/schema; an
LLM discovers which source attributes map to each target column, shows them in an
editable grid, and generates one JOIN `SELECT` that conforms to the target contract.
Everything runs **on behalf of (OBO)** the signed-in user.

**Features:** target-driven attribute discovery · multi-table JOIN SQL generation ·
target-schema validation (dry-run + column diff) · data preview · Excel/PDF export ·
review/approval workflow · few-shot mapping examples (**Example search**) · reference-PDF
grounding with citations (**Document search**) · Ask Genie · group-based roles.

**Contents:** [Prerequisites](#prerequisites) · [Install](#install) ·
[After installing](#after-installing) · [Re-running, resuming and updating](#re-running-resuming-and-updating) ·
[Uninstall / clean install](#uninstall--clean-install) · [Roles and permissions](#roles-and-permissions) ·
[How search works](#how-search-works) · [Troubleshooting](#troubleshooting) ·
[Configuration reference](#configuration-reference) · [Local development](#local-development) ·
[Security notes](#security-notes)

---

## Prerequisites

Check all of these before installing. The installer verifies most of them in its first
step and stops with an explanation if one is missing.

### Where you run the installer

| Need | Details |
|---|---|
| **Python 3.9 or newer** | No extra packages. Use `python3` on macOS/Linux; `python` or `py` on Windows. Check with `python3 --version`. |
| **Databricks CLI 1.18.0 or newer** | [Install guide](https://docs.databricks.com/dev-tools/cli/install.html). Check with `databricks --version`. |
| **Git** | To clone this repo (or download it as a ZIP). |
| **Network access to the workspace** | The CLI must reach `https://<workspace>.cloud.databricks.com`. If your network blocks that, run the installer in the workspace's own web terminal instead — see [Install from inside the workspace](#install-from-inside-the-workspace). |

Node.js is **not** needed: the app is built on the workspace during deploy.

### The Databricks workspace

| Need | Why |
|---|---|
| **Unity Catalog** | All tables, the documents volume and the indexes live in a UC schema. |
| **Identity federation** (account-level identities) | The three role groups are account groups. Almost all workspaces have this. |
| **Databricks Apps** | Hosts the app. |
| **A serverless (or Pro) SQL warehouse** | Runs the app's SQL, the Genie space and document parsing (`ai_parse_document` needs serverless). |
| **Foundation Model APIs**: a chat LLM endpoint (e.g. `databricks-claude-sonnet-4-5`) and `databricks-gte-large-en` | The LLM does the mapping; `databricks-gte-large-en` embeds examples and document passages. |
| **Vector Search** | Example search and Document search. The installer creates a Storage-Optimized endpoint, or reuses one. |
| **AI/BI Genie** | The Ask Genie panel. |
| **Serverless jobs** | The hourly index-sync job. |
| **Quota for one more app and one Vector Search endpoint** | Unless you reuse an existing endpoint with `--vs-endpoint`. |

### Your permissions (the person running the installer)

| Need | Used for |
|---|---|
| **Workspace admin** (recommended, not required) | Creating the role groups, adding them to the workspace, and sharing the warehouse and Vector Search endpoint with them. If you aren't one, an admin does these steps first and you run the installer: see [If you aren't a workspace admin](#if-you-arent-a-workspace-admin). |
| **On the catalog:** `USE CATALOG` + `CREATE SCHEMA`, and the right to grant on it (catalog **owner** or `MANAGE`) | Creating the app's schema and giving the role groups access to it. If the schema already exists, you need to own it or have `MANAGE` on it instead of `CREATE SCHEMA`. |
| **`CAN USE`** on the SQL warehouse and **`CAN QUERY`** on the LLM and embedding endpoints | Running the setup SQL and checking the endpoints. |
| **Allowed to create** apps, jobs, Genie spaces and Vector Search endpoints/indexes | Workspace admins normally are. |

App users need nothing in advance: the installer gives the role groups all the access the
app needs, and you then add people to the groups.

### If you aren't a workspace admin

Only a few of the installer's steps need workspace admin rights. A workspace admin can do
them once, ahead of time, as described below; then anyone can run the installer. You still
need the catalog, warehouse and endpoint permissions in the table above.

When a non-admin runs it, the installer says so in step 1 and then checks each of these as
it goes. If one is missing it stops (or, for step 3 below, warns) and names the step here
to ask the admin for. `status` shows the same checks without changing anything.

The commands use `databricks api`, the same calls the installer makes, so they work through
the CLI and need no extra tools. Set `P` to the admin's CLI profile first. If you install
with `--app-name` or custom `--*-group` names, use those group names instead.

**1. Create the three role groups and add them to the workspace.**

They must be **account** groups. Workspace-local groups can't hold Unity Catalog grants,
so don't use `databricks groups create`: it creates workspace-local groups.

In the UI, go to **Settings → Identity and access → Groups → Add group** in the workspace
(this creates an account group in identity-federated workspaces). Alternatively, use the
account console: **User management → Groups**, then **Workspaces → your workspace →
Permissions → Add**, and give the group the **User** permission.

From the CLI:

```bash
P=<admin-profile>
for G in aimapper-admins aimapper-editors aimapper-viewers; do
  GRP=$(databricks api post /api/2.0/account/scim/v2/Groups --profile $P \
        --json "{\"schemas\":[\"urn:ietf:params:scim:schemas:core:2.0:Group\"],\"displayName\":\"$G\"}" \
        | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
  # Add the group to this workspace
  databricks api put /api/2.0/preview/permissionassignments/principals/$GRP --profile $P \
    --json '{"permissions":["USER"]}'
done
```

**2. Make the person who will run the installer a manager of each group.**

Group managers can change a group's members and managers. The installer needs that to
add the first admin and to make the app's service principal a manager too (step 3).

In the UI, open each group, go to **Permissions → Grant access**, pick the user and choose
the **Group: Manager** role.

From the CLI, run the snippet below with `WHO="users/<installer-email>"`:

```bash
P=<admin-profile>
WHO="users/someone@example.com"   # or "servicePrincipals/<application-id>" (step 3)
ACC=$(databricks api get /.well-known/databricks-config --profile $P \
      | python3 -c 'import json,sys; print(json.load(sys.stdin)["account_id"])')
for G in aimapper-admins aimapper-editors aimapper-viewers; do
  GRP=$(databricks api get "/api/2.0/account/scim/v2/Groups?filter=displayName%20eq%20%22$G%22&attributes=id" --profile $P \
        | python3 -c 'import json,sys; print(json.load(sys.stdin)["Resources"][0]["id"])')
  RS="accounts/$ACC/groups/$GRP/ruleSets/default"
  # Read the group's current rule set and add WHO to its managers (keeps existing ones)
  BODY=$(databricks api get "/api/2.0/preview/accounts/access-control/rule-sets?name=$RS&etag=" --profile $P \
         | python3 -c '
import json, sys
rs, name, who = json.load(sys.stdin), sys.argv[1], sys.argv[2]
rules = rs.get("grant_rules") or []
mgr = next((r for r in rules if r["role"] == "roles/group.manager"), None)
if mgr is None:
    rules.append({"role": "roles/group.manager", "principals": [who]})
elif who not in mgr["principals"]:
    mgr["principals"].append(who)
print(json.dumps({"name": name, "rule_set": {"name": name, "etag": rs["etag"], "grant_rules": rules}}))
' "$RS" "$WHO")
  databricks api put /api/2.0/preview/accounts/access-control/rule-sets --profile $P --json "$BODY"
done
```

**3. Make the app's service principal a manager of each group.**

The app changes group membership (Admin → Roles) as its own service principal, so the
service principal must be a **Group: Manager** of all three groups. This is the only
permission it needs by hand. Its `CAN USE` on the SQL warehouse and `CAN QUERY` on the LLM
endpoint are granted automatically when the app is deployed.

The service principal only exists once the app has been created (installer step 10):

- **If the installing user is a group manager (step 2)**, the installer does this itself
  in step 11. Nothing to do.
- **Otherwise**, an admin does it after the install. Look up the service principal's
  application ID, then run the step 2 snippet with
  `WHO="servicePrincipals/<application-id>"`, or grant **Group: Manager** to the
  service principal in the UI.

  ```bash
  databricks apps get aimapper --profile $P -o json \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["service_principal_client_id"])'
  ```

Until this is done, adding people in Admin → Roles fails with a permission error.

**4. Let the installer share the SQL warehouse and Vector Search endpoint.**

The installer gives the role groups access to both, which needs `CAN MANAGE` on each:

```bash
databricks permissions update warehouses <warehouse-id> --profile $P \
  --json '{"access_control_list":[{"user_name":"<installer-email>","permission_level":"CAN_MANAGE"}]}'

# Only if the endpoint already exists; otherwise the installer creates it (and owns it),
# provided the installing user is allowed to create Vector Search endpoints.
databricks permissions update vector-search-endpoints <endpoint-id> --profile $P \
  --json '{"access_control_list":[{"user_name":"<installer-email>","permission_level":"CAN_MANAGE"}]}'
```

Get the endpoint ID with
`databricks vector-search-endpoints get-endpoint aimapper-retrieval --profile $P -o json`.

The catalog permissions (`USE CATALOG`, `CREATE SCHEMA`, and owner or `MANAGE`) come from
the catalog owner or a metastore admin, not a workspace admin. The app and the Genie space
are created by the installing user, who therefore manages them, so they need no extra
grant.

---

## Install

```bash
git clone https://github.com/shrish-dbr/aimapper.git
cd aimapper

databricks auth login --host https://<workspace>.cloud.databricks.com --profile customer
python3 setup/install.py install --profile customer --catalog <catalog>
```

That's the whole install: about 10–20 minutes, plus 5–15 if it has to create a new Vector
Search endpoint. To see what it will do first, run the same command with `status` instead
of `install`; it only reads the workspace.

### What the installer does

| # | Step | Details |
|---|---|---|
| 1 | Check prerequisites | CLI version, sign-in (and whether you're a workspace admin), catalog, warehouse, LLM and embedding endpoints, account groups. |
| 2 | Role groups | Creates `aimapper-admins`, `aimapper-editors` and `aimapper-viewers` (account groups) if missing and adds them to the workspace. |
| 3 | Schema, tables, volume, seed data | Creates the schema, all tables and the `reference_docs` volume. **On a new or empty schema** it also seeds the sample healthcare target schema, demo source tables (in `<schema>_source`), the default source systems (Epic, Cerner) and the example corpus. Existing data is never overwritten. |
| 4 | Unity Catalog grants | Gives each group exactly what its role needs on the catalog, schema, tables and volume. |
| 5 | Vector Search endpoint | Reuses `aimapper-retrieval` or creates it, waits until it's online, and lets the groups use it. |
| 6 | Warehouse access | Lets the groups use the SQL warehouse. |
| 7 | Genie space definition | Generates it from `setup/templates/genie_space.template.json` for your catalog and schema. |
| 8 | Adopt existing resources | Finds an existing app, job, Genie space or index with the same name and adopts it instead of creating a duplicate. Indexes are first compared with what the app expects (see below). |
| 9 | Check the deployment plan | Previews the deploy and **stops if it would delete or re-create the app or an index**. |
| 10 | Deploy | Deploys the bundle (`databricks.yml`: app, Genie space, both search indexes and the hourly sync job, with group permissions), then deploys the app code and starts it. |
| 11 | Group managers and first admin | Makes the app's service principal a manager of the role groups (so Admin → Roles can add people) and adds you to `aimapper-admins`. |
| 12 | Start index syncs | Starts the first sync of both search indexes. |

It ends by printing the app's URL.

### Common options

| Option | Default | Purpose |
|---|---|---|
| `--profile` | *(required)* | Databricks CLI profile for the workspace. |
| `--catalog` | *(required)* | Catalog for the app's schema. |
| `--schema` | `aimapper` | Schema for the app's tables, volume and indexes. |
| `--app-name` | `aimapper` | App name (≤26 lowercase letters, numbers, hyphens). Also names the job and Genie space, and (if not `aimapper`) the groups: `<app-name>-admins` etc. |
| `--warehouse` | first serverless warehouse | SQL warehouse name or id. |
| `--llm` | `databricks-claude-sonnet-4-5` | Chat LLM serving endpoint. |
| `--admins` | you | Bootstrap admin emails (always app admins). The first is added to the admin group. |
| `--vs-endpoint` | `aimapper-retrieval` | Vector Search endpoint to create or reuse. |
| `--admin-group` / `--editor-group` / `--viewer-group` | from `--app-name` | Use your own group names. |
| `--no-sample-data` | | Don't create the demo source tables on a fresh install. |
| `--sample-data` | | (Re)create the demo source tables on an existing install. |
| `--reseed-target-schema` | | Reset the target schema to the sample model (overwrites it). |
| `--recreate-indexes` | | Rebuild indexes that don't match what the app expects. |
| `--force-lock` | | Clear a deployment lock left by an interrupted run. |
| `--verbose` | | Print every CLI command the installer runs. |

`python3 setup/install.py install --help` lists everything.

### Existing resources and search indexes

The installer checks the workspace before changing anything and **adopts** what's already
there instead of duplicating it. Tables and data are kept, the Vector Search endpoint is
reused, and an existing app, job or Genie space with the same name is updated in place.

For each search index it compares the source table, primary key, embedding column and
model, synced columns and endpoint with what the app expects:

- **Matches:** reused as is, with no re-embedding.
- **Differs:** the installer stops and lists the differences without touching the index.
  Re-run with `--recreate-indexes` to drop and rebuild it (this re-embeds every row, and
  search returns nothing until it finishes), or choose another `--schema`.

### Install from inside the workspace

If the CLI can't reach the workspace from your machine:

1. **Workspace → Create → Git folder**: paste this repo's URL and create it.
2. Open a **web terminal** (from a notebook on serverless compute, or a cluster).
3. `cd` into the Git folder and run the install command. If `databricks auth profiles`
   shows no profile, create one first with
   `databricks auth login --host <workspace-url> --profile customer`.

### Install a second copy (e.g. for testing)

Use a different `--app-name` and `--schema`. The copy gets its own groups, job, Genie
space and indexes, and shares only the Vector Search endpoint:

```bash
python3 setup/install.py install --profile customer --catalog <catalog> \
  --app-name aimapper-test --schema aimapper_test
```

---

## After installing

1. **Open the app** (URL printed at the end, or Compute → Apps). The first visit asks you
   to authorize the app's sign-in scopes.
2. **Admin → Roles → Assign a role** to add people or groups. They get the role's access
   as soon as they're in its group; a signed-in user may need up to about 5 minutes to see
   a role change.
3. **References → Reference documents**: upload source-system PDFs (data dictionaries,
   field definitions). Each upload is parsed and indexed automatically.
4. **Mapper**: pick a project and target entity and generate a mapping.
5. Give users access to the **source data** they'll map. The installer only grants the
   app's own schema and the demo `<schema>_source` schema. For example:
   ``GRANT USE SCHEMA, SELECT ON SCHEMA <catalog>.<source_schema> TO `aimapper-viewers` ``
   (plus `USE CATALOG` on that catalog).

---

## Re-running, resuming and updating

**Every step is safe to re-run.** Each one checks what already exists before acting, so a
re-run skips finished work, never duplicates resources and never overwrites data.

- **If a step fails** (missing permission, quota, timeout, network…), the installer stops
  and prints which step failed, why, how to fix it, and the exact command to re-run. Fix
  the cause and run that command; it picks up where it stopped.
- **Settings are remembered** per app in `.databricks/installs/<app-name>.json`
  (git-ignored), so a re-run only needs `--profile` and `--app-name`. Pass an option again
  to change it.
- **Interrupted mid-deploy?** The CLI may leave a deployment lock behind. Locks over an
  hour old are cleared automatically. For a newer one the installer tells you; re-run with
  `--force-lock` if no other install of that app is running.

**Updating:**

| You want to… | Run |
|---|---|
| Deploy new app code (after `git pull`) | `python3 setup/install.py deploy --profile customer --app-name aimapper` |
| Change a setting (e.g. the LLM) | `python3 setup/install.py install --profile customer --app-name aimapper --llm <endpoint>` |
| See what's installed and what would change | `python3 setup/install.py status --profile customer --app-name aimapper` |

---

## Uninstall / clean install

```bash
# Preview what would be removed (changes nothing)
python3 setup/install.py uninstall --profile customer --app-name aimapper --dry-run

# Remove the app and its components; keep your data, groups and endpoint
python3 setup/install.py uninstall --profile customer --app-name aimapper

# Remove everything, for a completely clean slate
python3 setup/install.py uninstall --profile customer --app-name aimapper --all
```

You're asked to type the app name to confirm (`--yes` skips this, e.g. in CI).

| What | Plain `uninstall` | With flag |
|---|---|---|
| App, hourly sync job, Genie space, both search indexes, the bundle's deployment state | removed | |
| Schema: all tables, mappings, history, examples, settings and uploaded documents (plus the demo `<schema>_source` schema, if the installer created it) | kept | `--delete-data` removes |
| The three role groups and their members | kept | `--delete-groups` removes |
| Vector Search endpoint (only if no other index uses it) | kept | `--delete-endpoint` removes |
| All of the above | | `--all` |

- `--delete-data` refuses to drop a schema that doesn't look like an AI Mapper schema.
- If something can't be removed, the rest still are and the command says what failed;
  re-run it after fixing the cause.

When the role groups are deleted (`--delete-groups` or `--all`), the installer first
removes what it granted them outside the app's schema: their entries on the SQL warehouse
and Vector Search endpoint permissions, and their `USE CATALOG` grant on the catalog.
Local settings (`.databricks/installs/<app-name>.json` and the generated Genie file) are
deleted last, and only if everything else was removed, so a failed uninstall can be re-run.

**Clean install:** run `uninstall --all`, then the [install](#install) command again. To
start over but keep your data, run plain `uninstall` and re-install with the same
`--catalog` and `--schema`.

### Everything an install creates

| Object | Name (defaults) | Where to find it |
|---|---|---|
| App | `aimapper` | Compute → Apps |
| Sync job | `aimapper-retrieval-sync` | Jobs & Pipelines |
| Genie space | `aimapper-assistant` | Genie |
| Search indexes | `<catalog>.<schema>.aimapper_retrieval_index`, `<catalog>.<schema>.aimapper_reference_index` | Catalog Explorer → the schema, or Compute → Vector Search → the endpoint |
| Vector Search endpoint (if the installer created it) | `aimapper-retrieval` | Compute → Vector Search |
| Schema with all tables and the `reference_docs` volume | `<catalog>.<schema>` | Catalog Explorer |
| Demo source schema (fresh installs) | `<catalog>.<schema>_source` | Catalog Explorer |
| Role groups (account groups) | `aimapper-admins`, `aimapper-editors`, `aimapper-viewers` | Settings → Identity and access → Groups |
| Group permissions on shared objects | entries for the three groups on the SQL warehouse and Vector Search endpoint; `USE CATALOG` on the catalog | the object's **Permissions** dialog; Catalog Explorer → catalog → Permissions |
| Bundle deployment state and uploaded files | `/Workspace/Users/<you>/.bundle/aimapper/<app-name>` | Workspace browser |
| Local files (your machine) | `.databricks/installs/<app-name>.json`, `.databricks/generated/<app-name>.geniespace.json` | the repo folder |

With a custom `--app-name`, the app, job, Genie space and groups use that name instead of
`aimapper`.

### Removing everything by hand

Use this if you can't run the installer (for example the repo is gone). Work top to
bottom: the app and job first, data last. The CLI commands assume `--profile customer`;
each step can also be done in the UI listed above.

```bash
P="--profile customer"; APP=aimapper; CAT=<catalog>; SCH=aimapper

# 1. App, sync job and Genie space
databricks apps delete $APP $P
databricks jobs list --name $APP-retrieval-sync $P          # note the job_id
databricks jobs delete <job_id> $P
databricks genie list-spaces $P                             # find "<app>-assistant", note space_id
databricks genie trash-space <space_id> $P

# 2. Search indexes
databricks vector-search-indexes delete-index $CAT.$SCH.aimapper_retrieval_index $P
databricks vector-search-indexes delete-index $CAT.$SCH.aimapper_reference_index $P

# 3. Bundle deployment state
databricks workspace delete /Workspace/Users/<you>/.bundle/aimapper/$APP --recursive $P
```

Then, only if you want them gone too:

4. **Data** (permanent: every table, mapping, history row and uploaded document). In the
   SQL editor:
   ```sql
   DROP SCHEMA IF EXISTS <catalog>.aimapper CASCADE;
   DROP SCHEMA IF EXISTS <catalog>.aimapper_source CASCADE;  -- demo data, if it was created
   ```
5. **Group grants on shared objects:** in the SQL warehouse's and the Vector Search
   endpoint's **Permissions** dialogs, remove the three groups. In the SQL editor:
   ``REVOKE USE CATALOG ON CATALOG <catalog> FROM `aimapper-admins` `` (repeat for
   `aimapper-editors` and `aimapper-viewers`).
6. **Role groups:** Settings → Identity and access → Groups → delete the three groups (or
   ask an account admin to delete them in the account console).
7. **Vector Search endpoint**, only if nothing else uses it (check with
   `databricks vector-search-indexes list-indexes aimapper-retrieval $P`):
   `databricks vector-search-endpoints delete-endpoint aimapper-retrieval $P`
8. **Local files:** delete `.databricks/installs/<app-name>.json` and
   `.databricks/generated/<app-name>.geniespace.json` from the repo folder.

---

## Roles and permissions

Each role is a Databricks **account group** that holds every permission the role needs.
Assigning a role in **Admin → Roles** adds the person or group to that role's group.

| Role | Group | Can |
|---|---|---|
| Admin | `aimapper-admins` | everything, including configuration, deletes and role management |
| Editor | `aimapper-editors` | everything a viewer can, plus approve/reject reviews and curate examples, documents and instructions |
| Viewer | `aimapper-viewers` | generate SQL and submit mappings for review |

What the installer grants each group:

- **All roles:** `CAN USE` on the app and SQL warehouse, `CAN RUN` on the Genie space,
  `CAN USE` on the Vector Search endpoint; `USE CATALOG`; and on the schema `USE SCHEMA`,
  `SELECT` and `READ VOLUME`.
- **Viewers:** `MODIFY` on the run, step-log, feedback and user-preference tables.
- **Editors:** additionally `MODIFY` on the examples, retrieval corpus, projects,
  source-system instructions and reference-chunk tables, and `WRITE VOLUME` on
  `reference_docs`.
- **Admins:** `CAN MANAGE` on the app, warehouse, Genie space and endpoint; `ALL PRIVILEGES`
  and `MANAGE` on the schema.

Notes:

- A user's role is the **highest** role group they're in, directly or through a nested
  group, so you can add an existing team group to a role group. Workspace-local groups
  can't be members of account groups.
- People in no role group count as Viewers in the app, but without the groups' access they
  can't open it.
- **Bootstrap admins** (`--admins`) are always app admins, even outside the admin group.
- The app changes group membership as its **service principal**, after checking the
  caller is an app admin, because user sign-in tokens can't carry the `scim` scope.
- **Admin → Roles → Apply group permissions** re-applies the Unity Catalog, warehouse and
  endpoint grants from inside the app, which is useful as a repair. Only the installer can
  set the app and Genie permissions, so those rows show "Skipped".

---

## How search works

**Example search** (few-shot retrieval): approved mapping examples and approved history
are kept in `aimapper_retrieval_corpus` and embedded into `aimapper_retrieval_index`. Each
generation retrieves the most similar ones, filtered by project and target. Without the
index the app falls back to a lexical heuristic (recent examples ranked by column-name
overlap).

**Document search** (reference-PDF grounding):

1. Uploading, deleting or **Re-index documents** parses each changed file with
   `ai_parse_document` and splits it into ~1.5k-character passages (section-aware; tables
   become `a | b` rows; long tables are split by rows with the header repeated), stored in
   `aimapper_reference_chunks` (`server/aimapper/references.ts`).
2. `aimapper_reference_index` embeds the passages with `databricks-gte-large-en`.
3. Each mapping searches once per group of ~15 target columns, **filtered to the project's
   source system** (its folder in the volume, e.g. `Epic/`), and adds **whole** passages
   best-first up to the Tuning profile's cap: 10k / 20k / 30k characters for Conservative /
   Balanced / Generous. The Mapper shows which files and pages were used.

Both indexes are TRIGGERED (Storage-Optimized endpoints don't support continuous sync).
The app syncs them after changes, and the hourly `<app-name>-retrieval-sync` job rebuilds
the corpus and syncs both.

---

## Troubleshooting

The installer prints a "How to fix" line for every failure. The most common ones:

| Message | Fix |
|---|---|
| `… doesn't exist, and creating account groups needs a workspace admin` / `Couldn't give the role groups access to …` | You aren't a workspace admin and a one-time admin step is missing. The message names the step in [If you aren't a workspace admin](#if-you-arent-a-workspace-admin). |
| `couldn't make the app's service principal … a manager` (warning) | The app works, but Admin → Roles can't add people until an admin does step 3 in [If you aren't a workspace admin](#if-you-arent-a-workspace-admin). |
| `Catalog '…' doesn't exist` | Create it, or pass a catalog you can create schemas in. |
| `PERMISSION_DENIED` on a `GRANT` | You need to own, or have `MANAGE` on, the catalog and schema. Ask the catalog owner. |
| `Serving endpoint '…' doesn't exist` | Pass another `--llm`, or ask an admin to enable Foundation Model APIs. |
| `Index … doesn't match what the app expects` | Re-run with `--recreate-indexes`, or use another `--schema`. |
| `The deploy would delete or re-create …` | The app or an index exists with a different configuration. Check `--app-name`, `--catalog` and `--schema`. |
| `Another deployment … holds the lock` | If no other install of the app is running, re-run with `--force-lock`. |
| `timed out` / `temporarily unavailable` | Wait a minute and re-run; finished steps are skipped. |
| `certificate verify failed` | A corporate proxy is intercepting TLS. Configure the Databricks CLI for it (the installer only talks to Databricks through the CLI). |
| In the app: `Invalid scope` / `needs the '…' permission` | Sign out and back in, or open the app in a new private window, to re-authorize its scopes. |

---

## Configuration reference

All settings are **bundle variables** in `databricks.yml`. The installer sets them, so you
normally don't edit anything. The app reads them as environment variables:

| Variable (installer option) | App env | Purpose |
|---|---|---|
| `app_name` (`--app-name`) | — | App name; prefixes the job, Genie space and default group names |
| `catalog` (`--catalog`) | `AIMAPPER_CATALOG` | Catalog holding the app's schema |
| `schema` (`--schema`) | `AIMAPPER_SCHEMA` | The app's schema |
| `sql_warehouse_id` (`--warehouse`) | `DATABRICKS_WAREHOUSE_ID` | SQL warehouse |
| `serving_endpoint_name` (`--llm`) | `DATABRICKS_SERVING_ENDPOINT_NAME` | Default chat LLM (users can pick another in the app) |
| `admins` (`--admins`) | `AIMAPPER_ADMINS` | Bootstrap admin emails |
| `admin_group` / `editor_group` / `viewer_group` | `AIMAPPER_ADMIN_GROUP` … | Role groups |
| `vs_endpoint` (`--vs-endpoint`) | `AIMAPPER_VS_ENDPOINT` | Vector Search endpoint |
| — | `AIMAPPER_VS_INDEX`, `AIMAPPER_DOCS_INDEX` | `<catalog>.<schema>.aimapper_retrieval_index` and `…aimapper_reference_index` |
| — | `AIMAPPER_GENIE_SPACE_ID` | The Genie space the bundle creates |

The setup SQL is in `setup/0*.sql`, with the placeholders `your_catalog` and `aimapper`
that the installer replaces. You can still run a file by hand in the SQL editor after
replacing them.

> This repo intentionally has **no `package-lock.json` or `.npmrc`**: the Apps build
> installs dependencies from your workspace's own npm mirror, so it works on any network.
> Don't commit a lockfile pinned to another network's proxy.

---

## Local development

```bash
cp .env.example .env      # fill in profile, warehouse, endpoint, catalog, schema
npm install
npm run dev               # http://localhost:8000, hot reload
```

Useful scripts: `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`.

---

## Security notes

- No credentials, host, warehouse id or catalog are committed. The host comes from your
  CLI sign-in; everything else is a bundle variable set by the installer and saved in
  git-ignored files.
- Auth is **OBO** (the Apps proxy forwards the user's token) or the app's service
  principal, never a hard-coded token.
- Generated SQL is **read-only and validated** (a read-only guard plus a `LIMIT 0`
  dry-run); it's never executed as a write.
- `.env` and `.databricks/` are git-ignored.
