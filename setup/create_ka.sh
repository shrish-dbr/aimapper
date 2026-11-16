#!/usr/bin/env bash
# One-time provisioning of the AI Mapper Knowledge Assistant (Agent Bricks).
#
# Creates a Knowledge Assistant, points it at the reference_docs UC volume, and
# runs the first sync. Prints the KA id and its query serving-endpoint name —
# set those as AIMAPPER_KA_ID and AIMAPPER_KA_ENDPOINT in app.yaml.
#
# Prereqs:
#   - Databricks CLI >= 1.0.0 authenticated (pass --profile or set DATABRICKS_CONFIG_PROFILE)
#   - The reference_docs volume already exists (run setup/run_setup.py first, or 05_reference_docs.sql)
#
# Usage:
#   CATALOG=my_catalog SCHEMA=aimapper PROFILE=my_profile \
#     [APP_NAME=aimapper | APP_SP=<sp_client_id>] bash setup/create_ka.sh
#
# The KA is MANAGED BY THE APP SERVICE PRINCIPAL at runtime (re-sync + status), because
# the knowledge-assistants API needs the broad `all-apis` scope that a user/OBO token
# can't carry. So the app SP must have CAN_MANAGE on the KA. This script grants it —
# pass APP_NAME (the deployed app; the SP is looked up automatically) or APP_SP directly.
#
# Limits to keep in mind (managed KA): up to 10 knowledge sources per KA,
# files >100MB skipped, PDF/DOCX/PPTX >500 pages skipped, files starting with
# '_' or '.' skipped. Formats: PDF, TXT, MD, DOCX, PPT/PPTX.
set -euo pipefail

CATALOG="${CATALOG:?set CATALOG to your Unity Catalog catalog}"
SCHEMA="${SCHEMA:-aimapper}"
APP_NAME="${APP_NAME:-aimapper}"
PROFILE_ARG=""
if [[ -n "${PROFILE:-}" ]]; then PROFILE_ARG="--profile ${PROFILE}"; fi

VOLUME_PATH="/Volumes/${CATALOG}/${SCHEMA}/reference_docs/"

echo "Creating Knowledge Assistant…"
# shellcheck disable=SC2086
CREATE_JSON="$(databricks knowledge-assistants create-knowledge-assistant \
  "aimapper-reference-docs" \
  "Source-metadata reference documents used to ground AI Mapper's source-to-target mapping" \
  ${PROFILE_ARG} --output json)"

KA_NAME="$(echo "${CREATE_JSON}" | python3 -c 'import sys,json; print(json.load(sys.stdin)["name"])')"
echo "  -> ${KA_NAME}"

echo "Attaching knowledge source at ${VOLUME_PATH}…"
# shellcheck disable=SC2086
databricks knowledge-assistants create-knowledge-source \
  "${KA_NAME}" \
  --json "{\"display_name\":\"Reference PDFs\",\"description\":\"Source metadata references\",\"source_type\":\"files\",\"files\":{\"path\":\"${VOLUME_PATH}\"}}" \
  ${PROFILE_ARG} >/dev/null

echo "Triggering initial sync (takes a few minutes)…"
# shellcheck disable=SC2086
databricks knowledge-assistants sync-knowledge-sources "${KA_NAME}" ${PROFILE_ARG} >/dev/null

echo
echo "Done. Fetching endpoint name…"
# shellcheck disable=SC2086
GET_JSON="$(databricks knowledge-assistants get-knowledge-assistant "${KA_NAME}" ${PROFILE_ARG} --output json)"
ENDPOINT="$(echo "${GET_JSON}" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("endpoint_name") or d.get("serving_endpoint_name") or "")')"
KA_ID="${KA_NAME##*/}"

# Grant the app service principal CAN_MANAGE on the KA so the deployed app can
# re-sync + read its status at runtime (it acts as the SP for KA management).
# Resolve APP_SP from the deployed app if not provided explicitly.
if [[ -z "${APP_SP:-}" && -n "${APP_NAME}" ]]; then
  # shellcheck disable=SC2086
  APP_SP="$(databricks apps get "${APP_NAME}" ${PROFILE_ARG} --output json 2>/dev/null \
    | python3 -c 'import sys,json;
try:
    print(json.load(sys.stdin).get("service_principal_client_id",""))
except Exception:
    print("")' 2>/dev/null || echo '')"
fi
if [[ -n "${APP_SP:-}" ]]; then
  echo "Granting the app service principal (${APP_SP}) CAN_MANAGE on the KA…"
  # shellcheck disable=SC2086
  databricks knowledge-assistants update-permissions "${KA_ID}" ${PROFILE_ARG} \
    --json "{\"access_control_list\":[{\"service_principal_name\":\"${APP_SP}\",\"permission_level\":\"CAN_MANAGE\"}]}" >/dev/null \
    && echo "  granted (ACL changes take ~30-45s to propagate)" \
    || echo "  WARN: grant failed — grant CAN_MANAGE to the app SP manually, or re-sync will 403."
else
  echo "WARN: could not resolve the app service principal (set APP_NAME or APP_SP)."
  echo "      Grant it CAN_MANAGE on the KA manually, or in-app re-sync will fail with PERMISSION_DENIED."
fi

echo
echo "=================================================================="
echo "Set these in app.yaml (env):"
echo "  AIMAPPER_KA_ID       = ${KA_ID}"
echo "  AIMAPPER_KA_ENDPOINT = ${ENDPOINT:-<run get-knowledge-assistant to find the endpoint name>}"
echo "=================================================================="
echo
echo "The KA takes 2-5 min to come ONLINE. Check with:"
echo "  databricks knowledge-assistants get-knowledge-assistant \"${KA_NAME}\" ${PROFILE_ARG}"
