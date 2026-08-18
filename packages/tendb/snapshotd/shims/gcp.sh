# GCP platform shim — pf_* functions over Secret Manager REST using the
# metadata-server identity (no gcloud on the host). Contract names map
# "/tendb/a/b" → "tendb_a_b" (see terraform/docs/ENGINE-CONTRACT.md).
TENDB_PARAM_PREFIX="${TENDB_PARAM_PREFIX:-/tendb}"
GCP_MD="http://metadata.google.internal/computeMetadata/v1"

_gcp_project() {
  [ -n "${TENDB_GCP_PROJECT:-}" ] && { echo "$TENDB_GCP_PROJECT"; return; }
  curl -s -H "Metadata-Flavor: Google" "$GCP_MD/project/project-id"
}

_gcp_token() {
  curl -s -H "Metadata-Flavor: Google" \
    "$GCP_MD/instance/service-accounts/default/token" | jq -r .access_token
}

_gcp_secret_name() { # contract leaf → mapped secret id
  printf '%s/%s' "$TENDB_PARAM_PREFIX" "$1" | sed 's|^/||; s|/|_|g'
}

pf_get_param() {
  local project name out
  project=$(_gcp_project)
  name=$(_gcp_secret_name "$1")
  out=$(curl -sf -H "Authorization: Bearer $(_gcp_token)" \
    "https://secretmanager.googleapis.com/v1/projects/$project/secrets/$name/versions/latest:access") || return 1
  echo "$out" | jq -r .payload.data | base64 -d
}

pf_put_param() {
  local project name payload
  project=$(_gcp_project)
  name=$(_gcp_secret_name "$1")
  payload=$(printf '%s' "$2" | base64 | tr -d '\n')
  # Create-if-missing, then add a version.
  curl -sf -X POST -H "Authorization: Bearer $(_gcp_token)" \
    -H "Content-Type: application/json" \
    -d '{"replication":{"automatic":{}}}' \
    "https://secretmanager.googleapis.com/v1/projects/$project/secrets?secretId=$name" >/dev/null 2>&1 || true
  curl -sf -X POST -H "Authorization: Bearer $(_gcp_token)" \
    -H "Content-Type: application/json" \
    -d "{\"payload\":{\"data\":\"$payload\"}}" \
    "https://secretmanager.googleapis.com/v1/projects/$project/secrets/$name:addVersion" >/dev/null
}

pf_get_secret() {
  # Source URL lives in Secret Manager too; $1 is the raw secret id.
  local project out
  project=$(_gcp_project)
  out=$(curl -sf -H "Authorization: Bearer $(_gcp_token)" \
    "https://secretmanager.googleapis.com/v1/projects/$project/secrets/$1/versions/latest:access") || return 1
  echo "$out" | jq -r .payload.data | base64 -d
}

pf_self_ip() {
  curl -s -H "Metadata-Flavor: Google" "$GCP_MD/instance/network-interfaces/0/ip"
}

pf_data_device() {
  # The engine module attaches the data disk with device_name=tendb-data.
  local dev="/dev/disk/by-id/google-${TENDB_GCP_DATA_DISK:-tendb-data}"
  [ -e "$dev" ] && { readlink -f "$dev"; return 0; }
  return 1
}
