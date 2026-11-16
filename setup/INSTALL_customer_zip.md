# Customer install — ZIP upload, in-workspace, side-by-side

Runbook for installing AI Mapper into a customer workspace when you **cannot clone
the Git repo directly** (download a ZIP and upload it) and you want a **fresh, isolated
install** that runs **alongside** an existing older (`automapper`) deployment without
touching it.

The old app keeps running for reference; the new app gets its own schema, tables, and
(optional) Vector Search indexes for retrieval and reference-document grounding.

Placeholders used below:

- `<CAT>` — Unity Catalog catalog that will hold the app's tables
- `<OLD>` — the old app's schema (read-only here; never written to)
- `<WH_ID>` — SQL Warehouse id
- `<you>` — your workspace username

> **New schema name:** use **`aimapper`** (the app default, distinct from the old
> app's schema). This means the setup SQL needs only the catalog swapped — no other
> find/replace. If you must use a different schema name, see the note in Part 5.

---

## Part 1 — Build a clean ZIP (machine that has the repo)

`git archive` zips only tracked files (no `.git`, `node_modules`, `dist`, `.env`):

```bash
git archive --format=zip -o aimapper.zip <ref>
```

Use the branch/tag that contains the version you want to ship. Verify the ZIP has
`databricks.yml`, `app.yaml`, `package.json`, `setup/`, `server/`, `client/` at the top.

---

## Part 2 — Upload the ZIP into the workspace (UI, no CLI)

1. **Catalog** → open a **Volume** you can write to (or create one) → **Upload to this volume**.
2. Upload `aimapper.zip`; note the path, e.g. `/Volumes/<CAT>/<schema>/<vol>/aimapper.zip`.

(Volumes accept large/arbitrary files; the Workspace "Import" dialog is more limited.)

---

## Part 3 — Unzip into a Workspace folder (web terminal)

Open a **web terminal** on **serverless** compute. The `databricks` CLI here is already
authenticated as you — no login, no `-p profile`, no host.

```bash
mkdir -p /Workspace/Users/<you>/aimapper
cd /Workspace/Users/<you>/aimapper
unzip /Volumes/<CAT>/<schema>/<vol>/aimapper.zip -d .
ls   # expect: databricks.yml, app.yaml, package.json, setup/, server/, client/
```

(If you used GitHub's web "Download ZIP", it adds a wrapper folder — `cd` into it so
`databricks.yml` is in your current directory.)

---

## Part 4 — Gather values (web terminal)

```bash
databricks apps list                 # confirm NO app named "aimapper" exists yet
databricks warehouses list           # copy a running SQL warehouse id -> <WH_ID>
databricks serving-endpoints list    # pick a chat LLM endpoint (default: databricks-claude-sonnet-4-5)
databricks catalogs list             # confirm <CAT>
```

---

## Part 5 — Create the app's tables in the new `aimapper` schema

In each setup file, replace **`your_catalog` → `<CAT>`** and leave everything else alone.

> 🚫 Do **not** blanket-replace `aimapper` — the table names use it as a prefix and
> must stay (`aimapper_conversion_runs`, etc.). You only change `your_catalog`.

Run these in the SQL editor against the SQL warehouse, in order:

1. `setup/01_create_tables.sql` — creates all app tables
2. `setup/04_examples.sql` — `mapping_examples`
3. `setup/05_reference_docs.sql` — `reference_docs` volume
4. `setup/06_retrieval_corpus.sql` — `aimapper_retrieval_corpus`

🚫 **Skip** `02_seed_target_schema.sql` and `03_sample_source.sql` (demo data), and do **not** use
`run_setup.py` (it runs those).

Verify:

```bash
databricks schemas list <CAT>                 # 'aimapper' now exists
databricks tables list <CAT> aimapper     # target_schema, mapping_examples, aimapper_* present
```

> **Different schema name?** Also change the single line `USE SCHEMA aimapper;` →
> `USE SCHEMA <your_schema>;` in each file (and nothing else), and set
> `AIMAPPER_SCHEMA` to it in Part 7.

---

## Part 6 — (Optional) Seed from the old app — read-only, never modifies it

`target_schema` and `mapping_examples` kept their names across the rename, so you can
copy them from the old schema (this only **reads** `<OLD>`):

```sql
INSERT INTO <CAT>.aimapper.target_schema SELECT * FROM <CAT>.<OLD>.target_schema;
INSERT INTO <CAT>.aimapper.mapping_examples   SELECT * FROM <CAT>.<OLD>.mapping_examples;
-- optional continuity (old names are automapper_*):
-- INSERT INTO <CAT>.aimapper.aimapper_projects SELECT * FROM <CAT>.<OLD>.automapper_projects;
-- INSERT INTO <CAT>.aimapper.aimapper_domains  SELECT * FROM <CAT>.<OLD>.automapper_domains;
```

Skip entirely if you want the new instance to start clean.

---

## Part 7 — Edit `app.yaml`

Open `/Workspace/Users/<you>/aimapper/app.yaml` and set:

```yaml
  - name: AIMAPPER_CATALOG
    value: <CAT>
  - name: AIMAPPER_SCHEMA
    value: aimapper
  - name: AIMAPPER_ADMINS
    value: "<customer-admin-email>"   # comma-separated; always-admin bootstrap
  # Reference-PDF grounding (optional) — fill from Part 10, or leave blank to disable:
  - name: AIMAPPER_DOCS_INDEX
    value: ""
  # Vector Search (optional) — fill from Part 9, or leave blank for lexical retrieval:
  - name: AIMAPPER_VS_ENDPOINT
    value: ""
  - name: AIMAPPER_VS_INDEX
    value: ""
```

Leave the `DATABRICKS_WAREHOUSE_ID` / `DATABRICKS_SERVING_ENDPOINT_NAME` `valueFrom:`
blocks exactly as they are — they resolve from app resources wired at deploy.

---

## Part 8 — Deploy the app

```bash
cd /Workspace/Users/<you>/aimapper
databricks apps deploy --var="sql_warehouse_id=<WH_ID>,serving_endpoint_name=databricks-claude-sonnet-4-5"
```

- Builds client + server **on the app compute** (no local Node needed), creates the app
  **`aimapper`** (coexists with the old `automapper`), and auto-grants the app's
  service principal `CAN_USE` on the warehouse + `CAN_QUERY` on the endpoint. ~1–3 min.
- Omit `serving_endpoint_name=…` to accept the default `databricks-claude-sonnet-4-5`.

Verify:

```bash
databricks apps get aimapper -o json   # app_status.state = RUNNING; note "url"
```

---

## Part 9 — (Optional) Vector Search index

```bash
CATALOG=<CAT> SCHEMA=aimapper ENDPOINT=aimapper-retrieval bash setup/create_vector_index.sh
```

Put the printed `AIMAPPER_VS_ENDPOINT` / `AIMAPPER_VS_INDEX` into `app.yaml`
(Part 7), then **re-run Part 8** (env changes need a redeploy).

---

## Part 10 — (Optional) Reference-document grounding

```bash
CATALOG=<CAT> SCHEMA=aimapper ENDPOINT=aimapper-retrieval bash setup/create_reference_index.sh
```

Put the printed `AIMAPPER_DOCS_INDEX` into `app.yaml` (Part 7), **re-run Part 8**, then
click **Re-index documents** on the References page.

---

## Part 11 — Populate retrieval, grant users, verify

1. If you seeded examples (Part 6) and set up Vector Search: in the app,
   **Admin → "Rebuild retrieval corpus"** (rebuilds the corpus + re-syncs the index).
2. **Grant end users** (the app runs on-behalf-of each user) on `<CAT>.aimapper`:
   - `USE CATALOG <CAT>` + `USE SCHEMA <CAT>.aimapper`
   - `SELECT` + `MODIFY` on `target_schema`, `aimapper_conversion_runs`,
     `mapping_examples`, `aimapper_config`
   - `SELECT` (+ `USE`) on the **source** data they'll map
   - `CAN USE` on the SQL warehouse, `CAN QUERY` on the serving endpoint
   - `READ VOLUME`/`WRITE VOLUME` on `reference_docs`, `CAN USE` on the Vector Search endpoint
   - Simpler: run `setup/08_role_groups.py`, then **Admin → Roles → Apply group permissions**, and add users to the role groups (README step 7).
3. Final: app `RUNNING`, a test mapping generates, and the old `automapper` app still runs.

---

## Updating later (no git pull)

Repeat Parts 1–3 with a fresh ZIP into the same folder (overwrite), re-apply your
`app.yaml` edits (keep a saved copy), then re-run Part 8. For tiny tweaks you can edit
files in the Workspace folder directly and redeploy.

## Gotchas

- **Serverless web terminal must be enabled** — required for `unzip`, the setup scripts, and `databricks apps deploy`.
- **`app.yaml` env changes only take effect on redeploy** — hence the re-runs in Parts 9–10.
- **Old app is never touched** as long as you only write to the `aimapper` schema and only `SELECT` from `<OLD>`.
- The setup SQL pre-creates **all** app tables, so end users do **not** need `CREATE TABLE` on the schema.
