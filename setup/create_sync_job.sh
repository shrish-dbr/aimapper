#!/usr/bin/env bash
# Create the scheduled retrieval-index refresh job for AI Mapper.
#
# Uploads setup/retrieval_sync_notebook.py to the workspace and creates a serverless
# Lakeflow Job that runs it on a cron schedule — rebuilding the retrieval corpus and
# triggering a Vector Search index sync. This compensates for Storage-Optimized
# indexes being TRIGGERED-only (no continuous sync).
#
# Usage:
#   CATALOG=my_catalog SCHEMA=aimapper \
#   INDEX=my_catalog.aimapper.aimapper_retrieval_index \
#   PROFILE=my_profile [CRON='0 0 * * * ?'] bash setup/create_sync_job.sh
#
# Default schedule: hourly. CRON is a Quartz expression (Databricks uses Quartz).
set -euo pipefail

CATALOG="${CATALOG:?set CATALOG}"
SCHEMA="${SCHEMA:-aimapper}"
INDEX="${INDEX:?set INDEX to the full index name}"
CRON="${CRON:-0 0 * * * ?}"   # top of every hour
PROFILE_ARG=""
if [[ -n "${PROFILE:-}" ]]; then PROFILE_ARG="--profile ${PROFILE}"; fi

ME="$(databricks current-user me ${PROFILE_ARG} --output json | python3 -c 'import sys,json; print(json.load(sys.stdin)["userName"])')"
WS_PATH="/Workspace/Users/${ME}/aimapper_retrieval_sync"

echo "Importing sync notebook to ${WS_PATH}…"
# shellcheck disable=SC2086
databricks workspace import "${WS_PATH}" \
  --file setup/retrieval_sync_notebook.py --language PYTHON --format SOURCE --overwrite ${PROFILE_ARG}

echo "Creating scheduled job (cron: ${CRON})…"
# shellcheck disable=SC2086
databricks jobs create ${PROFILE_ARG} --json "{
  \"name\": \"aimapper-retrieval-sync\",
  \"tasks\": [{
    \"task_key\": \"rebuild_and_sync\",
    \"notebook_task\": {
      \"notebook_path\": \"${WS_PATH}\",
      \"source\": \"WORKSPACE\",
      \"base_parameters\": {\"catalog\": \"${CATALOG}\", \"schema\": \"${SCHEMA}\", \"index_name\": \"${INDEX}\"}
    }
  }],
  \"schedule\": {
    \"quartz_cron_expression\": \"${CRON}\",
    \"timezone_id\": \"UTC\",
    \"pause_status\": \"UNPAUSED\"
  },
  \"max_concurrent_runs\": 1
}"

echo
echo "Done. The job refreshes the corpus + index on schedule. Manage it under Workflows,"
echo "or run once now with: databricks jobs run-now <job_id> ${PROFILE_ARG}"
