#!/usr/bin/env bash
# One-time provisioning of the Vector Search index for semantic few-shot retrieval.
#
# Creates a Storage-Optimized Vector Search endpoint and a Delta Sync index (managed
# embeddings, CONTINUOUS) over the aimapper_retrieval_corpus table. The app then
# retrieves the most semantically-similar approved examples + history at generation
# time, hard-filtered by domain + target_table.
#
# Prereqs:
#   - The corpus table exists + is seeded: run setup/run_setup.py first
#     (or 06_retrieval_corpus.sql), so the index has a source with Change Data Feed on.
#   - Databricks CLI authenticated (pass --profile or set DATABRICKS_CONFIG_PROFILE).
#
# Usage:
#   CATALOG=my_catalog SCHEMA=aimapper PROFILE=my_profile bash setup/create_vector_index.sh
#
# Prints AIMAPPER_VS_ENDPOINT + AIMAPPER_VS_INDEX — set both in app.yaml.
set -euo pipefail

CATALOG="${CATALOG:?set CATALOG to your Unity Catalog catalog}"
SCHEMA="${SCHEMA:-aimapper}"
ENDPOINT="${ENDPOINT:-aimapper-retrieval}"
PROFILE_ARG=""
if [[ -n "${PROFILE:-}" ]]; then PROFILE_ARG="--profile ${PROFILE}"; fi

CORPUS="${CATALOG}.${SCHEMA}.aimapper_retrieval_corpus"
INDEX="${CATALOG}.${SCHEMA}.aimapper_retrieval_index"

echo "Creating Storage-Optimized Vector Search endpoint '${ENDPOINT}' (idempotent)…"
# shellcheck disable=SC2086
databricks vector-search-endpoints create-endpoint "${ENDPOINT}" STORAGE_OPTIMIZED ${PROFILE_ARG} 2>/dev/null \
  || echo "  (endpoint may already exist — continuing)"

echo "Waiting for the endpoint to be ONLINE (can take a few minutes)…"
# shellcheck disable=SC2086
for i in $(seq 1 40); do
  state="$(databricks vector-search-endpoints get-endpoint "${ENDPOINT}" ${PROFILE_ARG} --output json 2>/dev/null \
    | python3 -c 'import sys,json; print(json.load(sys.stdin).get("endpoint_status",{}).get("state",""))' 2>/dev/null || echo '')"
  echo "  [$i] endpoint state: ${state:-unknown}"
  [[ "$state" == "ONLINE" ]] && break
  sleep 15
done

# NOTE: Storage-Optimized endpoints support TRIGGERED sync only (not CONTINUOUS).
# The index refreshes when synced — the app's Admin → Retrieval "Rebuild" action
# rebuilds the corpus and triggers a sync; you can also schedule a periodic sync.
# When --json is used, ALL fields (name/endpoint/primary_key/index_type) go in the JSON.
echo "Creating Delta Sync index '${INDEX}' (managed embeddings, TRIGGERED)…"
# shellcheck disable=SC2086
databricks vector-search-indexes create-index ${PROFILE_ARG} --json "{
  \"name\": \"${INDEX}\",
  \"endpoint_name\": \"${ENDPOINT}\",
  \"primary_key\": \"id\",
  \"index_type\": \"DELTA_SYNC\",
  \"delta_sync_index_spec\": {
    \"source_table\": \"${CORPUS}\",
    \"pipeline_type\": \"TRIGGERED\",
    \"embedding_source_columns\": [
      {\"name\": \"content\", \"embedding_model_endpoint_name\": \"databricks-gte-large-en\"}
    ],
    \"columns_to_sync\": [\"id\", \"kind\", \"domain\", \"project_id\", \"target_table\", \"source_signature\", \"content\", \"generated_sql\"]
  }
}" || echo "  (index may already exist — continuing)"

echo
echo "=================================================================="
echo "Set these in app.yaml (env):"
echo "  AIMAPPER_VS_ENDPOINT = ${ENDPOINT}"
echo "  AIMAPPER_VS_INDEX    = ${INDEX}"
echo "=================================================================="
echo
echo "The index takes a few minutes to build its first embeddings. Check with:"
echo "  databricks vector-search-indexes get-index ${INDEX} ${PROFILE_ARG}"
