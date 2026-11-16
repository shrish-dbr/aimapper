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
| `setup/05_reference_docs.sql` | the `reference_docs` UC volume for Knowledge Assistant PDFs |
| `setup/06_retrieval_corpus.sql` | the `aimapper_retrieval_corpus` table (Vector Search source; approved examples + history) |

The `aimapper_config` table (stores the in-app selected target-schema table) is created
automatically on first save from the Config page.

---

## 3b. (Optional) Set up the Knowledge Assistant

The **References → Reference documents** tab lets users upload source-metadata
PDFs (data dictionaries, field definitions, ERDs) that are used to *ground* the
LLM's mapping. This is powered by a managed **Agent Bricks Knowledge Assistant**
pointed at the `reference_docs` volume created above. It is fully optional — with
no KA configured the app works exactly as before, just without doc grounding.

```bash
CATALOG=<your_catalog> SCHEMA=aimapper PROFILE=customer bash setup/create_ka.sh
```

The script prints an **`AIMAPPER_KA_ID`** and **`AIMAPPER_KA_ENDPOINT`** —
set both in `app.yaml` (step 4). Users then upload/delete PDFs and trigger a
re-sync from the References page.

> The app manages the KA (re-sync, status) **as its service principal**, because the
> knowledge-assistants API needs the broad `all-apis` scope a user token can't carry.
> The script grants the app SP `CAN_MANAGE` on the KA automatically (it resolves the SP
> from `APP_NAME`, default `aimapper`; or pass `APP_SP=<client_id>`). If that grant is
> skipped, in-app re-sync fails with `PERMISSION_DENIED` — grant it manually with
> `databricks knowledge-assistants update-permissions <ka_id> --json '{"access_control_list":[{"service_principal_name":"<app_sp_client_id>","permission_level":"CAN_MANAGE"}]}'`.

**KA limits:** ≤10 knowledge sources per KA (all PDFs share one volume source, so
this is not a per-file cap), files >100 MB skipped, PDF/DOCX/PPTX >500 pages
skipped, files starting with `_`/`.` skipped. Formats: PDF, TXT, MD, DOCX, PPT/PPTX.
The KA takes 2–5 min to come online, and each re-sync runs a few minutes.

---

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

**Recommended: `bash setup/deploy.sh [profile]`.** It runs the app deploy AND
re-grants the app service principal `CAN_MANAGE` on the Knowledge Assistant — a grant
the in-app "Re-sync Knowledge Base" button needs and that is NOT a DABs-managed
resource (so it can't live in `databricks.yml`). The SP is recreated whenever the app
is recreated, so tying the grant to deploy keeps re-sync working. Override defaults
via env (`APP_NAME`, `KA_ID`, `WAREHOUSE_ID`, `SERVING_ENDPOINT`).

```bash
bash setup/deploy.sh demojune2026
```

Under the hood it runs `databricks apps deploy`, which builds the app **on the
workspace** (installs deps + builds the React client server-side) and starts it:

```bash
databricks apps deploy -p customer \
  --var="sql_warehouse_id=<id>,serving_endpoint_name=databricks-claude-sonnet-4-5"
```

If you deploy with the bare command instead of `setup/deploy.sh`, remember to grant
the app SP `CAN_MANAGE` on the KA yourself (see `setup/create_ka.sh`), or in-app
re-sync will 403. If you created `variable-overrides.json`, a bare
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

## 7. Grant users access (OBO)

The app runs OBO, so **each end user** needs, in the customer workspace:

- `USE CATALOG` + `USE SCHEMA` on the catalog/schema holding the app's tables,
- `SELECT` + `MODIFY` on `target_schema`, `aimapper_conversion_runs`,
  `mapping_examples`, `aimapper_config`,
- `USE CATALOG`/`USE SCHEMA` + `SELECT` on the **source** data they want to map,
- `CAN USE` on the SQL Warehouse,
- `CAN QUERY` on the serving endpoint,
- (if the Knowledge Assistant is enabled) `READ VOLUME`/`WRITE VOLUME` on the
  `reference_docs` volume and `CAN QUERY` on the KA endpoint.

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
| `AIMAPPER_KA_ENDPOINT` | *(empty)* | Knowledge Assistant query endpoint (optional; enables doc grounding) |
| `AIMAPPER_KA_ID` | *(empty)* | Knowledge Assistant id, for the in-app re-sync button (optional) |
| `AIMAPPER_VS_ENDPOINT` | *(empty)* | Vector Search endpoint for semantic retrieval (optional) |
| `AIMAPPER_VS_INDEX` | *(empty)* | Vector Search index over the retrieval corpus (optional; empty ⇒ lexical retrieval) |

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
