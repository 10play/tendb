# Local platform shim — pf_* functions over the params.json the terraform
# local module renders (and the CLI's FileParamStore reads/writes). Names are
# used verbatim as JSON keys: { "<name>": { "value": "...", "secure": true } }.
# Atomic writes (tmp + rename) match cli/src/platform/local.ts.
TENDB_PARAM_PREFIX="${TENDB_PARAM_PREFIX:-/tendb}"
TENDB_PARAMS_FILE="${TENDB_PARAMS_FILE:-/state/params.json}"

pf_get_param() {
  jq -re --arg k "$TENDB_PARAM_PREFIX/$1" '.[$k].value // empty' "$TENDB_PARAMS_FILE" 2>/dev/null
}

pf_put_param() {
  local tmp
  tmp="$TENDB_PARAMS_FILE.tmp-$$"
  jq --arg k "$TENDB_PARAM_PREFIX/$1" --arg v "$2" '.[$k] = {value: $v}' \
    "$TENDB_PARAMS_FILE" 2>/dev/null > "$tmp" || printf '{"%s": {"value": "%s"}}\n' "$TENDB_PARAM_PREFIX/$1" "$2" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$TENDB_PARAMS_FILE"
}

pf_get_secret() {
  # Locally the source URL is passed straight to terraform; no secret store.
  echo "${TENDB_SOURCE_URL:-}"
}

pf_self_ip() { echo "127.0.0.1"; }

pf_data_device() {
  # The local zpool is file-backed and created by the host preflight script —
  # the daemon never creates it.
  return 1
}
