---
title: "Platform: GCP"
description: The tendb engine on Compute Engine — Secret Manager params, IAP tunnels, and what to watch on a first apply.
---

:::danger[Validate-only]
The GCP modules are syntax- and plan-validated but have **never been applied
to a real project**. Expect first-apply friction; read the module READMEs
before trusting them with anything that matters.
:::

The GCP platform mirrors the AWS shape one-to-one under the
[engine contract](/reference/engine-contract/): a Compute Engine host
(Ubuntu 24.04 amd64, pd-ssd data disk for the ZFS pool), Secret Manager as
the param store, and IAP TCP forwarding as the tunnel. Machine types by
`size`: `e2-medium` → `n2-highmem-2` → `n2-highmem-4` → `n2-highmem-8`.

## Provisioning

```sh
cd packages/tendb/terraform/examples/gcp-standalone
# copy terraform.tfvars.example → terraform.tfvars, fill in project/zone/source secret
terraform init && terraform apply
```

Modules: `modules/gcp/engine`, `modules/gcp/network` (custom-mode VPC +
subnet, Cloud NAT in `mode = "nat"`), `modules/gcp/console`. The source
database URL lives in a pre-created Secret Manager secret (same
out-of-band pattern as AWS); the engine's service account gets per-secret
IAM only — no project-wide roles.

All contract params are Secret Manager secrets with the
`/tendb/a/b → tendb_a_b` [name mapping](/reference/engine-contract/#per-backend-name-mapping).
`instance-id` publishes the full instance path
(`projects/<p>/zones/<z>/instances/<n>`) — the CLI parses zone and project
out of it to spawn the tunnel.

## Client setup

Clients need the **gcloud CLI**, authenticated (`gcloud auth login`) — the
CLI shells out to it for both secrets and tunnels, reusing your existing
auth. IAM for a client principal (the engine module's `client_iam_snippet`
output emits paste-ready Terraform):

- `roles/iap.tunnelResourceAccessor` on the engine instance
- Secret Manager **accessor** on the `tendb_*` secrets
- Secret Manager **versionAdder** on the snapshot/schema/alert secrets, for
  operators who trigger `tendb snapshots create` / `tendb schema sync`

Config:

```json
{
  "platform": "gcp",
  "gcpProject": "my-project",
  "paramPrefix": "/tendb"
}
```

(`gcpProject` is optional when your gcloud default project is the right
one.) `tendb status` reports `transport iap`.

## Caveats

- **The IAP firewall range is load-bearing**: `35.235.240.0/20` must be
  allowed to every tunneled port (2345, 2346, the clone range). The engine
  module creates that rule; if you bring your own firewall, keep it, or
  tunnels hang at connect.
- **Write-only token**: the verification token stays out of Terraform state
  via `secret_data_wo` — this pins `google >= 6.25` and `random >= 3.7`
  (plus Terraform >= 1.11).
- **Admin shell**: there is no SSM analog; port 22 over IAP is the admin
  path (no public SSH).
- **pd-ssd performance scales with disk size** — there are no IOPS knobs
  like gp3; size the data disk accordingly.
