-- Few-shot example store: known-good source->target conversions the app injects
-- into the SQL-generation prompt so future scripts follow established patterns.
-- Populated by architects (References tab) and by promoting successful runs.
--
-- Easiest: run `python setup/run_setup.py --catalog <your_catalog>`. To run by
-- hand instead, replace `your_catalog` below with your catalog name (and
-- `aimapper` with your schema if you changed it).
USE CATALOG your_catalog;
USE SCHEMA aimapper;

CREATE TABLE IF NOT EXISTS mapping_examples (
  example_id        STRING  NOT NULL COMMENT 'UUID',
  target_table      STRING  NOT NULL COMMENT 'target-schema table this example maps to',
  source_signature  STRING           COMMENT 'Human label, e.g. catalog.schema.table',
  source_columns    STRING           COMMENT 'Comma/space-joined source column tokens, for overlap ranking',
  generated_sql     STRING  NOT NULL COMMENT 'The known-good SELECT to learn from',
  notes             STRING           COMMENT 'Optional guidance on why this is a good pattern',
  approved          BOOLEAN          COMMENT 'Whether a human approved this example',
  domain            STRING           COMMENT 'Source system / EHR type (Epic, Cerner, …); default Epic',
  project_id        STRING           COMMENT 'Project (instance scope) this example belongs to',
  created_by        STRING,
  created_at        TIMESTAMP NOT NULL
)
USING DELTA
COMMENT 'Few-shot examples of source-to-target mapping SQL for prompt augmentation';
