# Azure boot shim — prepended to the shared init-core in custom_data. The
# pf_* functions are the single-source runtime shim
# (packages/tendb/snapshotd/shims/azure.sh) with the vault + prefix baked in.
export TENDB_AZURE_VAULT="${vault_name}"
export TENDB_PARAM_PREFIX="${param_prefix}"
${shim_body}

# RBAC gate, boot only (NOT part of the installed platform shim): the VM's
# role assignment on the vault is created after the VM and propagates
# asynchronously, while init-core fetches the token without retry. The shim
# needs curl+jq before init-core's own apt phase — installing twice is a
# no-op.
export DEBIAN_FRONTEND=noninteractive
for _ in $(seq 1 30); do
  apt-get update && apt-get install -y curl jq && break
  sleep 10
done
for _ in $(seq 1 90); do
  pf_get_param verification-token >/dev/null 2>&1 && break
  sleep 10
done
