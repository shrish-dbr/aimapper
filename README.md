# AI Mapper

A Databricks App ([AppKit](https://www.databricks.com/devhub/docs/appkit/v0/) — React /
TypeScript) that maps source Unity Catalog tables to a governed **target schema** and
generates validated Databricks SQL. Pick a target entity and a source
catalog/schema; an LLM discovers which source attributes map to each target
column, shows them in an editable grid, and generates one JOIN `SELECT` that
conforms to the target contract. Everything runs **on-behalf-of (OBO)** the
signed-in user.

**Features:** target-driven attribute discovery · multi-table JOIN SQL generation ·
Target-schema validation (dry-run + column diff) · top-20 data preview · Excel/PDF
export of the mapping · few-shot "References" store · configurable target
table · mapping history.

---

## Prerequisites

- A **Databricks workspace** with Unity Catalog and **Databricks Apps** enabled.
- A **SQL Warehouse** (serverless recommended).
- A **chat LLM serving endpoint** — a Databricks-hosted Foundation Model
  (e.g. `databricks-claude-sonnet-4-5`) or any endpoint with a `chat` task. The
  app lists available chat endpoints in a dropdown at runtime.
- **Databricks CLI ≥ 0.240** and **Node.js 22+ / npm** on the machine you deploy from.
- Permission to create an App and (for setup) to create tables in a UC catalog.

---

## 1. Get the code

```bash
git clone https://github.com/<org>/<repo>.git aimapper
cd aimapper
```

> Cross-network note: this repo intentionally contains **no `package-lock.json`
> and no `.npmrc`**. The Databricks Apps build environment installs dependencies
> against **your** workspace's own npm registry/mirror — so it works on any
> network without reaching an external or vendor-internal mirror. Do not commit a
> lockfile pinned to another workspace's proxy; it will break the build here.

---

## 2. Authenticate the CLI to the customer workspace

The workspace **host is not stored in this repo** — it comes from your CLI auth.

```bash
databricks auth login --host https://<customer-workspace>.cloud.databricks.com -p customer
databricks auth profiles          # verify the `customer` profile is Valid
```

Everything below passes `-p customer`. (You can also deploy from inside the
workspace via a Git folder + web terminal — see step 6, Option B.)

---

## 3. Create the tables

Pick a UC catalog to host the app's tables. The runner substitutes your
catalog/schema into the SQL and executes it:

```bash
export DATABRICKS_CONFIG_PROFILE=customer
python setup/run_setup.py \
  --catalog <your_catalog> \
  --warehouse-id <your_sql_warehouse_id>
```

It runs (also runnable by hand in the SQL editor — replace `your_catalog` first):

| File | Creates |
|------|---------|
| `setup/01_create_tables.sql` | `target_schema`, `aimapper_conversion_runs` |
| `setup/02_seed_target_schema.sql` | a sample healthcare target model (optional; replace with the customer's real target schema) |
| `setup/03_sample_source.sql` | normalized sample source tables that demonstrate multi-table JOINs (optional; demo data) |
| `setup/04_examples.sql` | the `mapping_examples` references store |
| `setup/05_reference_docs.sql` | the `reference_docs` UC volume for reference PDFs |
| `setup/06_retrieval_corpus.sql` | the `aimapper_retrieval_corpus` table (Vector Search source; approved examples + history) |

The `aimapper_config` table (stores the in-app selected target-schema table) is created
automatically on first save from the Config page.

---

## 3a. (Optional, recommended) Reference-document grounding with Vector Search

The **References → Reference documents** tab lets users upload source-metadata PDFs
(data dictionaries, field definitions, ERDs) that *ground* the LLM's mapping, using
**Vector Search over parsed passages**. Without it the app works the same, just without
doc grounding:

1. Upload / delete / **Re-index documents** → the app parses each changed file with
   `ai_parse_document`, splits it into ~1.5k-char passages (section-aware; tables
   flattened to `a | b` rows, long tables split by rows with the header repeated) and
   writes them to `aimapper_reference_chunks` (`server/aimapper/references.ts`).
2. A Delta Sync index embeds the passages (`databricks-gte-large-en`).
3. Each mapping queries the index once per group of ~15 target columns, **filtered to the
   project's source system** (the volume folder, e.g. `Epic/`), and packs **whole**
   passages best-first into the Prompt Sizing reference cap — 10k / 20k / 30k chars for
   Conservative / Balanced / Generous. The Mapper shows which files/pages grounded it.

```bash
# table (also created by run_setup.py), then the index on the retrieval endpoint (3c)
CATALOG=<your_catalog> SCHEMA=aimapper PROFILE=customer bash setup/create_reference_index.sh
```

Set the printed **`AIMAPPER_DOCS_INDEX`** in `app.yaml`, deploy, then click
**Re-index documents** once (References page) to parse documents already in the volume.
The `aimapper-editors` group gets `MODIFY` on the chunks table (step 7).

## 3c. (Optional) Set up semantic retrieval (Vector Search)

By default, mapping generation retrieves the top-3 few-shot examples for a target
using a **lexical** heuristic (recent same-domain examples ranked by column-name
overlap). That's fine up to hundreds of records. At **thousands**, enable
**Vector Search** for semantic retrieval over the *whole* approved corpus (approved
mapping examples + approved history), still hard-filtered by domain + target.

```bash
CATALOG=<your_catalog> SCHEMA=aimapper ENDPOINT=aimapper-retrieval PROFILE=customer \
  bash setup/create_vector_index.sh
```

It creates a Storage-Optimized endpoint + a Delta Sync index (managed embeddings,
**TRIGGERED** — Storage-Optimized doesn't support continuous sync) over
`aimapper_retrieval_corpus`, then prints **`AIMAPPER_VS_ENDPOINT`** and
**`AIMAPPER_VS_INDEX`** — set both in `app.yaml`. Leave them empty to keep the
lexical fallback. Grant the app SP (and users) **SELECT on the index**. The app keeps
the corpus *table* current via write-through as examples/history are approved; because
the index is TRIGGERED, embeddings refresh when synced — use **Admin → Retrieval →
Rebuild** (rebuilds the corpus and triggers a sync) or schedule a periodic sync job.
Query runs through the SQL warehouse (`vector_search()` TVF) under the existing `sql`
scope — no extra OBO scope needed.

---

## 4. Configure deploy-time values

Everything environment-specific is a **bundle variable** — nothing workspace-specific
is committed. Set them one of two ways:

**A. Inline `--var` on the deploy command** (step 5), **or**

**B. Git-ignored override file** (best for repeated deploys) — create
`.databricks/bundle/default/variable-overrides.json` (auto-loaded; `.databricks/`
is git-ignored):

```json
{
  "sql_warehouse_id": "<your_sql_warehouse_id>",
  "serving_endpoint_name": "databricks-claude-sonnet-4-5"
}
```

Then set the **catalog/schema** the app reads at runtime in **`app.yaml`** (it does
not support `${var}` substitution, so edit it directly):

```yaml
  - name: AIMAPPER_CATALOG
    value: <your_catalog>
  - name: AIMAPPER_SCHEMA
    value: aimapper
```

(The catalog can also be changed later in-app on the **Config** page.)

---

## 5. Deploy

`databricks apps deploy` builds the app **on the
workspace** (installs deps + builds the React client server-side) and starts it:

```bash
databricks apps deploy -p customer \
  --var="sql_warehouse_id=<id>,serving_endpoint_name=databricks-claude-sonnet-4-5"
```

If you created `variable-overrides.json`, a bare
`databricks apps deploy -p customer` works. Deploy takes ~1–3 min. Verify:

```bash
databricks apps get aimapper -p customer -o json   # app_status.state: RUNNING; `url` is the app URL
```

---

## 6. Deploy from inside the workspace (no local machine) — optional

If the customer network blocks local CLI access, deploy from the workspace:

1. **Workspace → Create → Git folder**, paste this repo's HTTPS URL, clone.
2. Open a **web terminal** on serverless compute; `cd` into the cloned folder.
3. Run step 3 (tables), edit `app.yaml` (step 4), then
   `databricks apps deploy` (host is already known inside the workspace).

---

## 7. Grant users access — role groups

Each app role is a Databricks **account group** that holds every permission the role
needs. Admins give someone a role by adding them to the group (in **Admin → Roles**);
nobody gets per-user grants.

| Role | Group | Can |
|---|---|---|
| Admin | `aimapper-admins` | everything, incl. config, deletes, role management |
| Editor | `aimapper-editors` | viewer + approve/reject reviews, curate references |
| Viewer | `aimapper-viewers` | generate SQL, submit mappings for review |

**One-time setup** (a workspace admin, after the first deploy):

```bash
python3 setup/08_role_groups.py --profile customer --app aimapper --first-admin you@example.com
```

This creates the three account groups (if missing), assigns them to the workspace,
makes the app's service principal a **Group manager** of each, and grants the groups
access to the **app** and the **Genie space** (admins `CAN MANAGE`; editors/viewers
`CAN USE` / `CAN RUN`). Those two can't be set from inside the app because app
sign-in tokens can't carry the `access-management` scope, so re-run the script if the
app or Genie space changes. That's needed because
user sign-in tokens can't carry the `scim` scope, so the app changes membership as its
service principal, after checking the caller is an app admin.

Then open the app → **Admin → Roles → Apply group permissions**. With your identity it
grants each group:

- **all roles:** `CAN USE` on the app and SQL warehouse, `CAN RUN` on the Genie space,
  `CAN USE` on the Vector Search
  endpoint, `USE CATALOG`, and on the schema `USE SCHEMA` + `SELECT` + `READ VOLUME`;
- **viewers:** `MODIFY` on the run/step/feedback/prefs tables;
- **editors:** additionally `MODIFY` on examples, retrieval corpus, projects, domain
  instructions and reference chunks, and `WRITE VOLUME` on `reference_docs`;
- **admins:** `CAN MANAGE` on every resource, `ALL PRIVILEGES` + `MANAGE` on the schema.

Re-run **Apply group permissions** whenever the app's resources change (e.g. a new
Genie space or Vector Search endpoint). Grants are recorded in `aimapper_permission_grants`.

Notes:

- A user's role is the highest role group they're in, **directly or through a nested
  group**, so you can add an existing account group (e.g. a team) to a role group.
  Workspace-local groups can't be members of account groups.
- People in no role group are treated as Viewers in the app, but without the groups'
  grants they can't open it unless they have access some other way.
- `AIMAPPER_ADMINS` (bootstrap admins) are always app admins; add them to
  `aimapper-admins` too so they get the resource access.
- Group names can be changed with `AIMAPPER_ADMIN_GROUP` / `AIMAPPER_EDITOR_GROUP` /
  `AIMAPPER_VIEWER_GROUP` (use the same names with the setup script's `--*-group` flags).
- **Source data** isn't covered: grant `USE CATALOG`/`USE SCHEMA` + `SELECT` on the
  source tables users map, e.g. to `aimapper-viewers`.

The app's service principal gets `CAN_USE` on the warehouse and `CAN_QUERY` on the
endpoint automatically at deploy time (declared in `databricks.yml`).

> First visit prompts each user to **authorize** the app's OBO scopes (`sql`,
> `serving`, `catalog.*`, `files`). If they see `Invalid scope` / `INSUFFICIENT_PERMISSIONS`,
> they need to re-authorize (open the app fresh / in a new session) after scopes change.

---

## Configuration reference

| Bundle var (`databricks.yml`) | Default | Purpose |
|---|---|---|
| `sql_warehouse_id` | *(required)* | Warehouse for statement execution → `DATABRICKS_WAREHOUSE_ID` |
| `serving_endpoint_name` | `databricks-claude-sonnet-4-5` | Default LLM endpoint (CAN_QUERY) → `DATABRICKS_SERVING_ENDPOINT_NAME` |

| `app.yaml` env | Default | Purpose |
|---|---|---|
| `AIMAPPER_CATALOG` | `your_catalog` | UC catalog holding the app's tables |
| `AIMAPPER_SCHEMA` | `aimapper` | Schema within the catalog |
| `AIMAPPER_DOCS_INDEX` | *(empty)* | Vector Search index over reference-PDF passages (optional; enables doc grounding) |
| `AIMAPPER_VS_ENDPOINT` | *(empty)* | Vector Search endpoint for semantic retrieval (optional) |
| `AIMAPPER_VS_INDEX` | *(empty)* | Vector Search index over the retrieval corpus (optional; empty ⇒ lexical retrieval) |
| `AIMAPPER_ADMINS` | *(empty)* | Bootstrap admin emails (always app admins) |
| `AIMAPPER_ADMIN_GROUP` / `_EDITOR_GROUP` / `_VIEWER_GROUP` | `aimapper-admins` / `-editors` / `-viewers` | Account groups that define the roles (step 7) |

Injected automatically at runtime: `DATABRICKS_HOST` and the OBO user token.

---

## Local development

```bash
cp .env.example .env      # fill in profile, warehouse, endpoint, catalog
npm install
npm run dev               # http://localhost:8000, hot reload
```

Useful scripts: `npm run typecheck`, `npm run lint`, `npm run build`,
`databricks apps validate -p <profile>`.

---

## Security notes

- No credentials, host, warehouse id, or catalog are committed. Host comes from CLI
  auth; the rest are bundle variables / `app.yaml` values with placeholder defaults.
- Auth is **OBO** (the Apps proxy forwards the user token) or the app service
  principal — never a hardcoded token.
- Generated SQL is **read-only and validated** (read-only guard + `LIMIT 0`
  dry-run) — it is never executed as a write.
- `.env` and `.databricks/` are git-ignored.
