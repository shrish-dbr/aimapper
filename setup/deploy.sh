#!/usr/bin/env bash
# Deploy the app AND grant its service principal CAN_MANAGE on the Knowledge
# Assistant in one step.
#
# WHY THIS SCRIPT EXISTS: the KA-agent ACL is NOT a DABs-managed app resource
# (unlike the SQL warehouse / serving-endpoint grants, which live in the
# `resources:` block of databricks.yml and are auto-granted on deploy). It's a
# separate `knowledge-assistants` API call. The app's in-app "Re-sync Knowledge
# Base" button runs as the app SERVICE PRINCIPAL and needs CAN_MANAGE on the KA,
# else it 403s ("do not have update access to the agent"). The SP is recreated
# whenever the app is recreated, so this grant must be re-applied on deploy — that's
# what this wrapper guarantees. The grant is idempotent (safe to re-run).
#
# Usage:
#   bash setup/deploy.sh [PROFILE]
#   # or override any of the vars:
#   PROFILE=demojune2026 APP_NAME=aimapper KA_ID=<id> \
#     WAREHOUSE_ID=<id> SERVING_ENDPOINT=<name> bash setup/deploy.sh
set -euo pipefail

# Defaults match the current demojune2026 deployment; override via env as needed.
PROFILE="${1:-${PROFILE:-demojune2026}}"
APP_NAME="${APP_NAME:-aimapper}"
WAREHOUSE_ID="${WAREHOUSE_ID:-eec23c8273cf1fb6}"
SERVING_ENDPOINT="${SERVING_ENDPOINT:-databricks-claude-opus-4-8}"
KA_ID="${KA_ID:-e4c2dc3f-a95a-4bb5-8e6b-ea6f44c0f2a6}"

cd "$(dirname "$0")/.."  # run from the app dir (where databricks.yml lives)

echo "==> Deploying ${APP_NAME} (profile: ${PROFILE})…"
databricks apps deploy --auto-approve -p "${PROFILE}" \
  --var="sql_warehouse_id=${WAREHOUSE_ID},serving_endpoint_name=${SERVING_ENDPOINT}"

echo "==> Resolving the app service principal…"
APP_SP="$(databricks apps get "${APP_NAME}" -p "${PROFILE}" --output json \
  | python3 -c 'import sys,json; print(json.load(sys.stdin).get("service_principal_client_id",""))')"

if [[ -z "${APP_SP}" ]]; then
  echo "WARN: could not resolve the app service principal — grant CAN_MANAGE on the KA manually,"
  echo "      or the in-app Re-sync will fail with PERMISSION_DENIED."
  exit 0
fi

echo "==> Granting the app SP (${APP_SP}) CAN_MANAGE on KA ${KA_ID}…"
if databricks knowledge-assistants update-permissions "${KA_ID}" -p "${PROFILE}" \
     --json "{\"access_control_list\":[{\"service_principal_name\":\"${APP_SP}\",\"permission_level\":\"CAN_MANAGE\"}]}" >/dev/null; then
  echo "    granted (ACL changes propagate in ~30–45s)."
else
  echo "  WARN: grant failed — grant CAN_MANAGE to the app SP manually, or in-app Re-sync will 403."
fi

echo "==> Done. App: https://${APP_NAME}-7474648654971217.aws.databricksapps.com"
