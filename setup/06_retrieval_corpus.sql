-- Retrieval corpus for semantic (Vector Search) few-shot retrieval.
--
-- Unions APPROVED mapping examples + APPROVED history runs into one text-per-row
-- corpus. A Delta Sync Vector Search index (created by setup/install.py)
-- embeds the `content` column so mapping generation can retrieve the most
-- semantically-similar prior mappings — ranked over the WHOLE corpus, not just a
-- recency window — hard-filtered by the current project (or, with Cross-Project
-- Learning on, by source system) + target_table.
--
-- Change Data Feed is REQUIRED for a CONTINUOUS Delta Sync index to pick up changes.
--
-- Normally run by the installer (python3 setup/install.py install). To run by
-- hand, replace `your_catalog` with your catalog (and `aimapper` if you changed
-- the schema).
USE CATALOG your_catalog;
USE SCHEMA aimapper;

CREATE TABLE IF NOT EXISTS aimapper_retrieval_corpus (
  id               STRING NOT NULL COMMENT 'example:<id> or run:<item_id>',
  kind             STRING          COMMENT 'example | history',
  domain           STRING          COMMENT 'Source system / EHR type (Epic, Cerner, …)',
  project_id       STRING          COMMENT 'Project (instance scope) this row belongs to',
  target_table     STRING          COMMENT 'target entity',
  source_signature STRING          COMMENT 'Human label, e.g. catalog.schema.table',
  content          STRING          COMMENT 'Text embedded by the Vector Search index',
  generated_sql    STRING          COMMENT 'The known-good SELECT to few-shot with',
  updated_at       TIMESTAMP
)
USING DELTA
TBLPROPERTIES (delta.enableChangeDataFeed = true)
COMMENT 'Vector Search source corpus: approved mapping examples + approved history';

-- Initial backfill from the base tables (idempotent full replace).
INSERT OVERWRITE aimapper_retrieval_corpus BY NAME
SELECT concat('example:', example_id) AS id, 'example' AS kind,
       coalesce(domain, 'Epic') AS domain,
       coalesce(project_id, concat('default::', lower(coalesce(domain, 'Epic')))) AS project_id,
       target_table, source_signature,
       concat('Target entity: ', target_table,
              coalesce(concat('\nSource: ', source_signature), ''),
              coalesce(concat('\nSource columns: ', source_columns), ''),
              concat('\nStructure: ', concat_ws('; ',
                nullif(concat_ws(', ',
                  CASE WHEN contains(lower(generated_sql), 'union') THEN 'union' END,
                  CASE WHEN contains(lower(generated_sql), 'with ') THEN 'cte' END,
                  CASE WHEN contains(lower(generated_sql), 'case when') THEN 'case' END,
                  CASE WHEN contains(lower(generated_sql), 'over(') OR contains(lower(generated_sql), 'over (') THEN 'window' END,
                  CASE WHEN regexp_count(lower(generated_sql), 'select') > 1 THEN 'subquery' END), ''),
                concat('joins=', cast(regexp_count(lower(generated_sql), 'join') AS STRING))))) AS content,
       generated_sql, CURRENT_TIMESTAMP() AS updated_at
FROM mapping_examples
WHERE approved = true AND generated_sql IS NOT NULL
UNION ALL
SELECT concat('run:', item_id) AS id, 'history' AS kind,
       coalesce(domain, 'Epic') AS domain,
       coalesce(project_id, concat('default::', lower(coalesce(domain, 'Epic')))) AS project_id,
       target_table,
       concat_ws('.', source_catalog, source_schema, source_table) AS source_signature,
       concat('Target entity: ', target_table,
              coalesce(concat('\nSource: ', concat_ws('.', source_catalog, source_schema, source_table)), ''),
              concat('\nStructure: ', concat_ws('; ',
                nullif(concat_ws(', ',
                  CASE WHEN contains(lower(generated_sql), 'union') THEN 'union' END,
                  CASE WHEN contains(lower(generated_sql), 'with ') THEN 'cte' END,
                  CASE WHEN contains(lower(generated_sql), 'case when') THEN 'case' END,
                  CASE WHEN contains(lower(generated_sql), 'over(') OR contains(lower(generated_sql), 'over (') THEN 'window' END,
                  CASE WHEN regexp_count(lower(generated_sql), 'select') > 1 THEN 'subquery' END), ''),
                concat('joins=', cast(regexp_count(lower(generated_sql), 'join') AS STRING))))) AS content,
       generated_sql, CURRENT_TIMESTAMP() AS updated_at
FROM aimapper_conversion_runs
WHERE lower(coalesce(approval_status, 'draft')) = 'approved'
  AND target_table IS NOT NULL AND generated_sql IS NOT NULL;
