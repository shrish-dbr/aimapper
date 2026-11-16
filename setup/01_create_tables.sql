-- AI Mapper setup: creates ALL Unity Catalog tables the app uses (target
-- schema, conversion-run history, projects, vendors, feedback, roles, app config,
-- source systems + instructions, schema versions, user prefs). The app also creates
-- any missing table at runtime, but pre-creating them here means end users (who run
-- the app on-behalf-of themselves) don't need CREATE TABLE on the schema.
--
-- Easiest: run `python setup/run_setup.py --catalog <your_catalog>` which
-- substitutes your catalog/schema and runs all setup files for you.
-- To run by hand instead, replace `your_catalog` below with your catalog name
-- (and `aimapper` with your schema if you changed it).
CREATE CATALOG IF NOT EXISTS your_catalog;
CREATE SCHEMA IF NOT EXISTS your_catalog.aimapper;
USE CATALOG your_catalog;
USE SCHEMA aimapper;

-- ---------------------------------------------------------------------------
-- target schema. One row per (target_table, target_column). This is the
-- contract the generated SQL must conform to: name, type, length, nullability.
-- transform_hint feeds the LLM domain-specific mapping guidance.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS target_schema (
  target_table      STRING  NOT NULL COMMENT 'Logical target table name (e.g. member, provider, enrollment)',
  target_column     STRING  NOT NULL COMMENT 'Target column name',
  ordinal_position  INT     NOT NULL COMMENT 'Column order within the target table',
  data_type         STRING  NOT NULL COMMENT 'Target data type (STRING, INT, DATE, DECIMAL, ...)',
  data_length       INT              COMMENT 'Max length for STRING/CHAR types; NULL if N/A',
  numeric_precision INT              COMMENT 'Precision for DECIMAL types',
  numeric_scale     INT              COMMENT 'Scale for DECIMAL types',
  is_nullable       BOOLEAN NOT NULL COMMENT 'Whether the target column allows NULLs',
  is_primary_key    BOOLEAN          COMMENT 'Whether the column is part of the logical primary key',
  description       STRING           COMMENT 'Business description of the column',
  transform_hint    STRING           COMMENT 'Optional transformation guidance fed to the LLM'
)
USING DELTA
COMMENT 'target schema definitions for source-to-target automapping';

-- ---------------------------------------------------------------------------
-- Conversion run history. One row per generated mapping (per source table),
-- grouped by run_id so a multi-table run shares an id.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aimapper_conversion_runs (
  run_id            STRING  NOT NULL COMMENT 'UUID grouping all source tables generated in one user action',
  item_id           STRING  NOT NULL COMMENT 'UUID for this single source->target item within the run',
  created_at        TIMESTAMP NOT NULL COMMENT 'When the item was generated',
  created_by        STRING           COMMENT 'OBO user email/principal that ran the conversion',
  source_catalog    STRING  NOT NULL,
  source_schema     STRING  NOT NULL,
  source_table      STRING  NOT NULL COMMENT 'Single source table for this item',
  target_table      STRING           COMMENT 'Resolved target-schema table (NULL if skipped/unmatched)',
  endpoint_name     STRING  NOT NULL COMMENT 'LLM serving endpoint used',
  match_method      STRING           COMMENT 'llm_auto | manual_override | skipped',
  match_confidence  DOUBLE           COMMENT 'LLM confidence 0..1 for the detected target',
  match_rationale   STRING           COMMENT 'LLM reasoning for the target match',
  generated_sql     STRING           COMMENT 'The generated SELECT statement',
  status            STRING  NOT NULL COMMENT 'SUCCESS | WARNINGS | FAILED | SKIPPED',
  validation_report STRING           COMMENT 'JSON per-column diff vs the target schema (matched/mismatch/missing/extra)',
  error_message     STRING           COMMENT 'Compile or validation error, if any',
  duration_ms       BIGINT           COMMENT 'End-to-end generate+validate time for this item',
  mappings_json     STRING           COMMENT 'JSON of the attribute mappings that produced the SQL (enables reload & lineage)',
  version           INT              COMMENT 'Version number per target_table (incremented on each save)',
  domain            STRING           COMMENT 'Source system / EHR type (Epic, Cerner, …); default Epic',
  project_id        STRING           COMMENT 'Project (instance scope) this run belongs to',
  approval_status   STRING           COMMENT 'Approval lifecycle: draft | in_review | approved | rejected',
  reviewed_by       STRING           COMMENT 'User who approved/rejected (NULL until reviewed)',
  reviewed_at       TIMESTAMP        COMMENT 'When the approval decision was made',
  review_note       STRING           COMMENT 'Optional reviewer note on the decision'
)
USING DELTA
COMMENT 'History of source-to-target automapping conversions, grouped by run_id';

-- ---------------------------------------------------------------------------
-- Projects: the instance-level scope. Create a separate project per source-system
-- installation (e.g. two different Epic hospitals). One source system per project;
-- every run/example belongs to one. The app auto-creates a "Default — <SourceSystem>"
-- project per source system and backfills legacy rows to it on first use.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aimapper_projects (
  project_id    STRING  NOT NULL COMMENT 'Project id (UUID, or default::<sourcesystem> for the seeded defaults)',
  name          STRING  NOT NULL COMMENT 'Display name',
  description   STRING           COMMENT 'Optional note',
  source_system STRING  NOT NULL COMMENT 'The one EHR type this project maps from (Epic, Cerner, …)',
  vendor_code   STRING           COMMENT 'Optional vendor (FK to aimapper_vendors.vendor_code) the source EHR comes from',
  schema_version_id STRING         COMMENT 'target-schema version this project maps to (FK to aimapper_schema_versions.version_id)',
  created_by    STRING           COMMENT 'Creator email/principal',
  created_at    TIMESTAMP        COMMENT 'When the project was created',
  archived      BOOLEAN          COMMENT 'Soft-hide flag; archived projects are excluded from selectors'
)
USING DELTA
COMMENT 'Mapping projects — the instance-level scope (one source system per project)';

-- ---------------------------------------------------------------------------
-- Vendors: the EHR product a project's source data comes from. Curated by admins
-- (Admin → Vendors) and selectable when creating a project. vendor_code is the key.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aimapper_vendors (
  vendor_code STRING  NOT NULL COMMENT 'Short unique code, e.g. EPIC, ORCL_CERNER',
  name        STRING  NOT NULL COMMENT 'Display name, e.g. Epic Systems',
  description STRING           COMMENT 'Optional note',
  created_by  STRING           COMMENT 'Creator email/principal',
  created_at  TIMESTAMP        COMMENT 'When the vendor was added'
)
USING DELTA
COMMENT 'EHR vendors selectable when creating a project';

-- ---------------------------------------------------------------------------
-- Feedback (Feature 10): 👍/👎 votes on target↔source mapping picks. Aggregated
-- votes steer future attribute discovery (confirmed picks preferred, rejected
-- picks avoided). Auto-created by the app on first vote if missing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aimapper_feedback (
  target_table   STRING  NOT NULL COMMENT 'target-schema table',
  target_column  STRING  NOT NULL COMMENT 'target column being voted on',
  source_table   STRING           COMMENT 'Source table of the voted mapping',
  source_column  STRING           COMMENT 'Source column of the voted mapping',
  vote           STRING  NOT NULL COMMENT 'up | down',
  project_id     STRING           COMMENT 'Project the vote was cast in (NULL = legacy/global)',
  created_at     TIMESTAMP        COMMENT 'When the vote was cast',
  created_by     STRING           COMMENT 'OBO user who voted'
)
USING DELTA
COMMENT 'User feedback on source-to-target mapping picks (steers future discovery)';

-- ---------------------------------------------------------------------------
-- Roles (Feature 5): per-user role for the approval workflow. One row per user.
--   viewer  -> generate SQL + submit mappings for review (default; no row needed)
--   editor  -> also approve/reject reviews & curate references
--   admin   -> full control incl. config, deletes, and role management
-- Users with no row default to 'viewer'. Bootstrap the first admin(s) via the
-- AIMAPPER_ADMINS env var (comma-separated emails) so they can grant others.
-- Auto-created by the app on first use if missing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aimapper_roles (
  user_email  STRING  NOT NULL COMMENT 'User email/principal the role applies to',
  role        STRING  NOT NULL COMMENT 'viewer | editor | admin',
  updated_by  STRING           COMMENT 'Admin who last set this role',
  updated_at  TIMESTAMP        COMMENT 'When the role was last changed',
  principal_type STRING        COMMENT 'user | group (NULL = user). For groups, user_email holds the group display name; members inherit its role'
)
USING DELTA
COMMENT 'Per-user roles for the AI Mapper approval workflow (viewer/editor/admin)';

-- ---------------------------------------------------------------------------
-- App config: the in-app selected target-schema table (single-row). Set on the
-- Config page; the app reads it to know which target-schema table is active. Auto-created
-- by the app on first use if missing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aimapper_config (
  id         STRING  NOT NULL COMMENT 'Row id (singleton key)',
  target_schema_table STRING           COMMENT 'Fully-qualified target-schema table currently selected',
  updated_at TIMESTAMP        COMMENT 'When the selection was last changed',
  updated_by STRING           COMMENT 'User who changed it'
)
USING DELTA
COMMENT 'AI Mapper app configuration (selected target-schema table)';

-- ---------------------------------------------------------------------------
-- Source systems (EHR types): the catalog of source systems (Epic, Cerner, …)
-- selectable on projects/runs/examples. Admin-managed; the app seeds Epic +
-- Cerner on first use. Auto-created by the app if missing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aimapper_domains (
  name        STRING  NOT NULL COMMENT 'Source-system / EHR name (e.g. Epic, Cerner)',
  description STRING           COMMENT 'Optional note',
  created_by  STRING           COMMENT 'Creator email/principal',
  created_at  TIMESTAMP        COMMENT 'When the source system was added'
)
USING DELTA
COMMENT 'Source systems (EHR types) selectable on projects/runs/examples';

-- ---------------------------------------------------------------------------
-- Per-source-system mapping instructions: admin-authored guidance injected into
-- the identify + generate prompts for a given source system. One row per domain.
-- Auto-created by the app if missing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aimapper_domain_instructions (
  domain       STRING  NOT NULL COMMENT 'Source system the instructions apply to',
  instructions STRING           COMMENT 'Guidance text fed to the LLM prompts',
  updated_by   STRING           COMMENT 'Admin who last edited',
  updated_at   TIMESTAMP        COMMENT 'When the instructions were last changed'
)
USING DELTA
COMMENT 'Per-source-system mapping instructions injected into the LLM prompts';

-- ---------------------------------------------------------------------------
-- schema versions: named versions of the target schema. Projects reference a
-- version (aimapper_projects.schema_version_id) so different installs can map to
-- different target-schema revisions. The app seeds a 'Default' version on first use.
-- Auto-created by the app if missing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aimapper_schema_versions (
  version_id  STRING  NOT NULL COMMENT 'Version id (UUID, or the default version id)',
  label       STRING  NOT NULL COMMENT 'Display label (e.g. Default, v2)',
  target_schema_table  STRING  NOT NULL COMMENT 'Fully-qualified target-schema table for this version',
  description STRING           COMMENT 'Optional note',
  is_default  BOOLEAN          COMMENT 'Whether this is the default version',
  created_by  STRING           COMMENT 'Creator email/principal',
  created_at  TIMESTAMP        COMMENT 'When the version was created',
  updated_at  TIMESTAMP        COMMENT 'When the version was last updated'
)
USING DELTA
COMMENT 'Named target-schema versions (each project references one)';

-- ---------------------------------------------------------------------------
-- Per-user preferences (one row per user_email): remembered default endpoint,
-- source catalog/schema/target, and UI theme. Auto-created by the app if missing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aimapper_user_prefs (
  user_email       STRING  NOT NULL COMMENT 'User email/principal these prefs belong to',
  default_endpoint STRING           COMMENT 'Remembered default LLM serving endpoint',
  default_catalog  STRING           COMMENT 'Remembered default source catalog',
  default_schema   STRING           COMMENT 'Remembered default source schema',
  default_target   STRING           COMMENT 'Remembered default target entity',
  theme            STRING           COMMENT 'UI theme: system | light | dark',
  updated_at       TIMESTAMP        COMMENT 'When prefs were last saved'
)
USING DELTA
COMMENT 'Per-user AI Mapper preferences (defaults + theme)';

-- ---------------------------------------------------------------------------
-- Generic admin key/value settings (e.g. the Prompt Sizing profile that drives
-- generation token budgets + prompt/example/sample size caps). Single row per
-- key. Auto-created by the app on first use if missing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aimapper_settings (
  key        STRING  NOT NULL COMMENT 'Setting key (e.g. prompt_profile)',
  value      STRING           COMMENT 'Setting value (e.g. conservative | balanced | generous)',
  updated_by STRING           COMMENT 'Admin who last changed it',
  updated_at TIMESTAMP        COMMENT 'When it was last changed'
)
USING DELTA
COMMENT 'Admin key/value settings (e.g. prompt_profile)';

-- ---------------------------------------------------------------------------
-- Permission ledger: resource permissions AI Mapper granted when an admin assigned
-- a role (app, warehouse, Genie, KA endpoint, Vector Search, UC schema/tables).
-- Removing or lowering a role revokes only grants recorded here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aimapper_permission_grants (
         principal STRING NOT NULL COMMENT 'User email or group display name',
         principal_type STRING NOT NULL COMMENT 'user | group',
         grant_key STRING NOT NULL COMMENT 'acl|<objectType>|<id> or uc|<securable>|<name>|<privilege>',
         kind STRING NOT NULL COMMENT 'acl | uc',
         object_type STRING COMMENT 'Permissions API object type or UC securable type',
         object_id STRING COMMENT 'Object id or fully-qualified UC name',
         privilege STRING COMMENT 'Granted permission level / UC privilege',
         prior_level STRING COMMENT 'ACL only: principal''s direct level before the app changed it (NULL = none)',
         granted_by STRING, granted_at TIMESTAMP
       )
USING DELTA
COMMENT 'Resource permissions granted by AI Mapper role assignments';
