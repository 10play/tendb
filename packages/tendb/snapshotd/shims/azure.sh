# Azure platform shim — pf_* functions over Key Vault REST using the VM's
# managed identity (no az CLI on the host). Contract names map
# "/tendb/a/b" → "tendb-a-b" (see terraform/docs/ENGINE-CONTRACT.md).
# Requires TENDB_AZURE_VAULT (the vault name; baked in by the engine module).
TENDB_PARAM_PREFIX="${TENDB_PARAM_PREFIX:-/tendb}"
AZ_KV_API="7.4"

_az_token() {
  curl -s -H "Metadata: true" \
    "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fvault.azure.net" \
    | jq -r .access_token
}

_az_secret_name() { # contract leaf → mapped secret name
  printf '%s/%s' "$TENDB_PARAM_PREFIX" "$1" | sed 's|^/||; s|/|-|g'
}

_az_vault_url() { echo "https://${TENDB_AZURE_VAULT}.vault.azure.net"; }

pf_get_param() {
  local name out
  name=$(_az_secret_name "$1")
  out=$(curl -sf -H "Authorization: Bearer $(_az_token)" \
    "$(_az_vault_url)/secrets/$name?api-version=$AZ_KV_API") || return 1
  echo "$out" | jq -r .value
}

pf_put_param() {
  local name
  name=$(_az_secret_name "$1")
  jq -n --arg v "$2" '{value: $v}' | curl -sf -X PUT \
    -H "Authorization: Bearer $(_az_token)" -H "Content-Type: application/json" \
    -d @- "$(_az_vault_url)/secrets/$name?api-version=$AZ_KV_API" >/dev/null
}

pf_get_secret() {
  # Source URL lives in the same vault; $1 is the raw secret name.
  local out
  out=$(curl -sf -H "Authorization: Bearer $(_az_token)" \
    "$(_az_vault_url)/secrets/$1?api-version=$AZ_KV_API") || return 1
  echo "$out" | jq -r .value
}

pf_self_ip() {
  curl -s -H "Metadata: true" \
    "http://169.254.169.254/metadata/instance/network/interface/0/ipv4/ipAddress/0/privateIpAddress?api-version=2021-02-01&format=text"
}

pf_data_device() {
  # First data-disk LUN on the Azure SCSI bus.
  local dev="/dev/disk/azure/scsi1/lun${TENDB_AZURE_DATA_LUN:-0}"
  [ -e "$dev" ] && { readlink -f "$dev"; return 0; }
  return 1
}
