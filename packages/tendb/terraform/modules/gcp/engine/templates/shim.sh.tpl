# GCP boot shim: env pins first, then the runtime shim verbatim (single
# source: packages/tendb/snapshotd/shims/gcp.sh — the project comes from the
# metadata server, which is always right for the VM itself).
export TENDB_PARAM_PREFIX="${param_prefix}"
export TENDB_GCP_DATA_DISK="${data_device_name}"
${shim_body}
