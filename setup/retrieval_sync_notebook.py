# Databricks notebook source
# Scheduled retrieval-index refresh for AI Mapper.
#
# Rebuilds the aimapper_retrieval_corpus from the base tables (approved mapping
# examples + approved history) and triggers a sync of the TRIGGERED Delta Sync
# Vector Search index so its embeddings pick up the changes. Runs on serverless.
#
# Parameters (job widgets): catalog, schema, index_name.

# COMMAND ----------
dbutils.widgets.text("catalog", "")
dbutils.widgets.text("schema", "aimapper")
dbutils.widgets.text("index_name", "")

catalog = dbutils.widgets.get("catalog")
schema = dbutils.widgets.get("schema")
index_name = dbutils.widgets.get("index_name")
assert catalog and index_name, "catalog and index_name are required"

corpus = f"{catalog}.{schema}.aimapper_retrieval_corpus"
examples = f"{catalog}.{schema}.mapping_examples"
runs = f"{catalog}.{schema}.aimapper_conversion_runs"

# COMMAND ----------
# Full-replace rebuild of the corpus (approved examples + approved history),
# shaping the same `content` text the app's write-through builds.
spark.sql(f"""
INSERT OVERWRITE {corpus}
SELECT concat('example:', example_id) AS id, 'example' AS kind,
       coalesce(domain, 'Epic') AS domain,
       coalesce(project_id, concat('default::', lower(coalesce(domain, 'Epic')))) AS project_id,
       target_table, source_signature,
       concat('Target entity: ', target_table,
              coalesce(concat('\\nSource: ', source_signature), ''),
              coalesce(concat('\\nSource columns: ', source_columns), ''),
              concat('\\nStructure: ', concat_ws('; ',
                nullif(concat_ws(', ',
                  CASE WHEN contains(lower(generated_sql), 'union') THEN 'union' END,
                  CASE WHEN contains(lower(generated_sql), 'with ') THEN 'cte' END,
                  CASE WHEN contains(lower(generated_sql), 'case when') THEN 'case' END,
                  CASE WHEN contains(lower(generated_sql), 'over(') OR contains(lower(generated_sql), 'over (') THEN 'window' END,
                  CASE WHEN regexp_count(lower(generated_sql), 'select') > 1 THEN 'subquery' END), ''),
                concat('joins=', cast(regexp_count(lower(generated_sql), 'join') AS STRING))))) AS content,
       generated_sql, current_timestamp() AS updated_at
FROM {examples} WHERE approved = true AND generated_sql IS NOT NULL
UNION ALL
SELECT concat('run:', item_id) AS id, 'history' AS kind,
       coalesce(domain, 'Epic') AS domain,
       coalesce(project_id, concat('default::', lower(coalesce(domain, 'Epic')))) AS project_id,
       target_table,
       concat_ws('.', source_catalog, source_schema, source_table) AS source_signature,
       concat('Target entity: ', target_table,
              coalesce(concat('\\nSource: ', concat_ws('.', source_catalog, source_schema, source_table)), ''),
              concat('\\nStructure: ', concat_ws('; ',
                nullif(concat_ws(', ',
                  CASE WHEN contains(lower(generated_sql), 'union') THEN 'union' END,
                  CASE WHEN contains(lower(generated_sql), 'with ') THEN 'cte' END,
                  CASE WHEN contains(lower(generated_sql), 'case when') THEN 'case' END,
                  CASE WHEN contains(lower(generated_sql), 'over(') OR contains(lower(generated_sql), 'over (') THEN 'window' END,
                  CASE WHEN regexp_count(lower(generated_sql), 'select') > 1 THEN 'subquery' END), ''),
                concat('joins=', cast(regexp_count(lower(generated_sql), 'join') AS STRING))))) AS content,
       generated_sql, current_timestamp() AS updated_at
FROM {runs}
WHERE lower(coalesce(approval_status,'draft')) = 'approved' AND target_table IS NOT NULL AND generated_sql IS NOT NULL
""")
print("corpus rows:", spark.table(corpus).count())

# COMMAND ----------
# Trigger the index to re-embed. Ignore "already running" — a sync is already in flight.
from databricks.sdk import WorkspaceClient
try:
    WorkspaceClient().vector_search_indexes.sync_index(index_name=index_name)
    print("sync triggered for", index_name)
except Exception as e:
    print("sync note:", e)

# COMMAND ----------
# Reference-document grounding index (Vector Search passages of the reference PDFs).
# The app re-indexes chunks on upload/delete/re-sync; this sync is the safety net for
# a sync the app couldn't start (e.g. the index was mid-sync). Optional widget.
dbutils.widgets.text("reference_index_name", "")
reference_index_name = dbutils.widgets.get("reference_index_name")
if reference_index_name:
    try:
        WorkspaceClient().vector_search_indexes.sync_index(index_name=reference_index_name)
        print("sync triggered for", reference_index_name)
    except Exception as e:
        print("reference sync note:", e)
