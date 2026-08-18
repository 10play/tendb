# tendb engine module (gcp)

The DBLab host on GCP: one Compute Engine VM (Ubuntu 24.04 + ZFS on a pd-ssd)
running `dblab-server` in Docker, wired to the same engine contract as the
AWS module (see `terraform/docs/ENGINE-CONTRACT.md`). Init is composed from
the shared core (`modules/common/engine-init`) plus the GCP pf_* shim
(`packages/tendb/snapshotd/shims/gcp.sh` — single source with the runtime
daemon).

**Status: validate-only.** This module has never been applied; the AWS module
is the battle-tested reference.

```hcl
module "engine" {
  source = "…/tendb/terraform/modules/gcp/engine"

  name              = "tendb"
  zone              = "us-central1-a"
  network_self_link = module.network.network_self_link
  subnet_self_link  = module.network.subnet_self_link

  client_cidr_ranges = [module.network.cidr] # direct TCP; IAP tunnels work regardless

  size                   = "medium"  # small | medium | large | xlarge (+ per-knob overrides)
  postgres_major_version = 18        # MUST match the source — no default
  source_secret_id       = "tendb-source-url" # created out of band
}
```

## Design points

- **Params are Secret Manager secrets**, mapped `"/tendb/a/b"` → `"tendb_a_b"`.
  Terraform creates every contract secret — runtime namespaces included, as
  empty (version-less) secrets — so the engine SA needs only per-secret
  `secretAccessor` grants plus `secretVersionAdder` on `dbname`. No
  project-wide roles.
- **Secrets never touch state or metadata.** The host pulls the source URL and
  its token at boot via the metadata-server identity. The token is generated
  ephemerally and written with `secret_data_wo` — hence google provider
  `>= 6.25`, random `>= 3.7`, terraform `>= 1.11`.
- **IAP is the transport.** The firewall admits Google's fixed IAP block
  `35.235.240.0/20` on 22/2345/2346 + the clone range for
  `gcloud compute start-iap-tunnel`; clients additionally need
  `roles/iap.tunnelResourceAccessor` on the instance (the
  `client_iam_snippet` output is a paste-ready grant).
- **instance-id** is published as
  `projects/<p>/zones/<z>/instances/<n>` — the CLI parses this exact format;
  its absence is the "platform is down" signal.
- **Startup-script changes replace the instance** (provider forces new) and
  destroy the pool with every clone on it — grep plans for "must be replaced".
