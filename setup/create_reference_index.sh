#!/usr/bin/env bash
# One-time provisioning of reference-document grounding via Vector Search. Creates a Delta Sync index over aimapper_reference_chunks on the
# existing retrieval endpoint. The app fills the table: upload documents in References →
# Reference documents, or click "Re-index documents" once to parse what's already there.
#
# Prereqs: setup/07_reference_chunks.sql has run (table exists with Change Data Feed on),
#          the Vector Search endpoint exists (setup/create_vector_index.sh creates it).
#
# Usage:
#   CATALOG=my_catalog SCHEMA=aimapper PROFILE=my_profile bash setup/create_reference_index.sh
#
# Prints AIMAPPER_DOCS_INDEX — set it in app.yaml (env).
set -euo pipefail

CATALOG="${CATALOG:?set CATALOG to your Unity Catalog catalog}"
SCHEMA="${SCHEMA:-aimapper}"
ENDPOINT="${ENDPOINT:-aimapper-retrieval}"
PROFILE_ARG=""
if [[ -n "${PROFILE:-}" ]]; then PROFILE_ARG="--profile ${PROFILE}"; fi

TABLE="${CATALOG}.${SCHEMA}.aimapper_reference_chunks"
INDEX="${CATALOG}.${SCHEMA}.aimapper_reference_index"

echo "Creating Delta Sync index '${INDEX}' on '${ENDPOINT}' (managed embeddings, TRIGGERED)…"
# shellcheck disable=SC2086
databricks vector-search-indexes create-index ${PROFILE_ARG} --json "{
  \"name\": \"${INDEX}\",
  \"endpoint_name\": \"${ENDPOINT}\",
  \"primary_key\": \"chunk_id\",
  \"index_type\": \"DELTA_SYNC\",
  \"delta_sync_index_spec\": {
    \"source_table\": \"${TABLE}\",
    \"pipeline_type\": \"TRIGGERED\",
    \"embedding_source_columns\": [
      {\"name\": \"embed_text\", \"embedding_model_endpoint_name\": \"databricks-gte-large-en\"}
    ],
    \"columns_to_sync\": [\"chunk_id\", \"source_system\", \"file_name\", \"file_path\", \"chunk_index\", \"page_start\", \"page_end\", \"heading\", \"content\", \"char_count\"]
  }
}" || echo "  (index may already exist — continuing)"

echo
echo "=================================================================="
echo "Set this in app.yaml (env):"
echo "  AIMAPPER_DOCS_INDEX = ${INDEX}"
echo "Then deploy, and click References → Reference documents → Re-index documents."
echo "=================================================================="
