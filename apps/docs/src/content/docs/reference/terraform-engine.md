---
title: "Terraform: engine module"
description: Full input, output, and size-preset reference for the tendb engine Terraform module, including which changes replace the instance.
---

The engine module builds the tendb host: one EC2 instance (Ubuntu 24.04, ZFS on a dedicated gp3 EBS volume) running [DBLab Engine](https://postgres.ai/) (`dblab-server`) in Docker. It logically dumps and restores a source Postgres into a ZFS pool and serves copy-on-write thin-clone databases on a pool of ports.

The module is private-first by design: no SSH, no key pair, IMDSv2 only. Admin access goes through SSM Session Manager, and clients (the tendb CLI, CI) reach the host through SSM port-forwards — no inbound security group rules required. See [Security model](/concepts/security/) for the full posture.

Module path in the repo: `packages/tendb/terraform/modules/engine`.

## Requirements

- Terraform `>= 1.11` — the API verification token is written with the write-only `value_wo` argument so it never enters Terraform state or plan.
- AWS provider `~> 6.0`.

## Usage

```hcl
module "engine" {
  source = "git::https://github.com/10play/tendb.git//packages/tendb/terraform/modules/engine?ref=main"

  name      = "tendb"
  vpc_id    = "vpc-0123456789abcdef0"
  subnet_id = "subnet-0123456789abcdef0"

  # Who may reach the API (2345) + clone ports over direct TCP.
  # SSM tunnels work regardless — leave both empty for tunnel-only access.
  allowed_security_group_ids = [aws_security_group.app_nodes.id]
  # and/or: allowed_cidr_blocks = ["10.60.0.0/16"]

  size                    = "medium"  # small | medium | large | xlarge
  postgres_major_version  = 18        # MUST match the source — no default
  source_secret_arn       = "arn:aws:secretsmanager:eu-north-1:123456789012:secret:tendb/source-url"
  source_secret_json_key  = null      # or e.g. "DATABASE_URL" for JSON secrets
  dump_exclude_extensions = []        # ["pg_session_jwt"] when the source is Neon

  create_client_iam_policy = true     # attach the output to CI/operator roles
}
```

:::tip
Pin `ref=` to a tag or commit rather than `main`. This module replaces the instance — and destroys all branches — when its user-data template changes, so you want module upgrades to be deliberate. See [Changes that replace the instance](#changes-that-replace-the-instance).
:::

The source secret is created out of band so the connection URL never lands in Terraform state:

```bash
aws secretsmanager create-secret --name tendb/source-url \
  --secret-string 'postgres://user:pass@host:5432/dbname'
```

The host pulls the secret at boot via its instance profile — the URL never transits Terraform state, plan, or user-data.

## Inputs

### Identity and placement

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | `"tendb"` | Prefix for every named resource: security group, IAM role, instance profile, instance `Name` tag. Also the default basis for `ssm_prefix` (`/<name>`) and `ssm_access_tag_value`. |
| `vpc_id` | `string` | — (required) | VPC to place the engine host in. |
| `subnet_id` | `string` | — (required) | Subnet for the engine host. |
| `associate_public_ip` | `bool` | `false` | Give the host a public IP. Pair with the [network module's](/reference/terraform-network/) `public` mode. |
| `ami_id` | `string` | `null` | AMI override. `null` resolves the latest Ubuntu 24.04 amd64 AMI from Canonical's public SSM parameter. Pin this for existing deployments — an AMI bump replaces the instance. |
| `tags` | `map(string)` | `{}` | Extra tags merged onto every resource. |
| `ssm_access_tag_value` | `string` | `null` (→ `name`) | Value of the `Role` tag on the instance. The client IAM policy conditions SSM SendCommand/StartSession on this tag, so client access survives instance replacement. |

### Client access

These govern **direct TCP** access only. SSM port-forwarding (what the tendb CLI uses) works with both lists empty — that is the zero-ingress default.

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `allowed_security_group_ids` | `list(string)` | `[]` | Security groups allowed to reach port 2345 (DBLab API) and the clone port range. |
| `allowed_cidr_blocks` | `list(string)` | `[]` | CIDRs allowed to reach 2345 and the clone port range. Also gates the optional `sync_target_port`. |

### Sizing

Pick a `size` preset, then override individual knobs — a non-null override always wins over the preset value. See [Size presets](#size-presets) for the exact numbers.

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `size` | `string` | `"small"` | T-shirt preset: `small` (POC), `medium` (team sandbox), `large` (up to ~100 GB sources), `xlarge` (200 GB–1 TB sources). Validated — anything else fails plan. |
| `instance_type` | `string` | `null` | EC2 instance type override. |
| `root_volume_gb` | `number` | `null` | Root gp3 volume size override. |
| `data_volume_gb` | `number` | `null` | Size of the ZFS pool volume. Thin clones **and** the logical dump both live here. |
| `data_volume_iops` | `number` | `null` | Provisioned IOPS on the data volume. `null` means the gp3 baseline (3000). |
| `data_volume_throughput` | `number` | `null` | Provisioned throughput on the data volume in MB/s. `null` means the gp3 baseline (125 MB/s). |
| `clone_port_range` | `object({ from = number, to = number })` | `null` | Clone Postgres port pool. Its width is the hard cap on concurrent clones. |
| `postgres_configs` | `map(string)` | `{}` | `postgresql.conf` settings merged over the preset's. These apply **per clone** — every clone allocates its own `shared_buffers`. |
| `shm_size` | `string` | `null` | Docker `shm-size` for clone containers, e.g. `"1g"`. |
| `dump_parallel_jobs` | `number` | `null` | `pg_dump` parallelism override. |
| `restore_parallel_jobs` | `number` | `null` | `pg_restore` parallelism override. |

### Source database

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `source_secret_arn` | `string` | — (required) | Secrets Manager secret holding the source Postgres URL. The host pulls it at boot via its instance profile — it never transits Terraform state or user-data. |
| `source_secret_json_key` | `string` | `null` | JSON key within the secret that holds the URL (e.g. `NEON_DATABASE_URL`). `null` means the whole SecretString **is** the URL. |
| `postgres_major_version` | `number` | — (required) | Postgres major version of the **source**. No default on purpose: the clone image's major must match or restore fails. |
| `clone_image` | `string` | `null` | Clone Postgres image override. `null` derives `postgresai/extended-postgres:<major>-0.8.0`. Override if postgres.ai's tag scheme drifts. |
| `server_image` | `string` | `"postgresai/dblab-server:4.1.3"` | DBLab server Docker image. |
| `dump_exclude_extensions` | `list(string)` | `[]` | Extensions excluded from `pg_dump` via `--exclude-extension=`. Example: `pg_session_jwt`, a Neon-proprietary extension that cannot be installed in stock Postgres. |
| `refresh_cron` | `string` | `"0 2 * * *"` | Full data refresh schedule (daily at 02:00 by default). DBLab skips a scheduled refresh non-destructively while clones exist. Ignored when `streaming_snapshots = true`. |
| `skip_start_refresh` | `bool` | `false` | Skip the initial dump/restore at boot. |

### Engine behavior

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `ui_enabled` | `bool` | `true` | Run DBLab's embedded UI, bound to host loopback `127.0.0.1:2346` only — reachable exclusively via SSM tunnel (`tendb ui`). |
| `ui_image` | `string` | `"postgresai/ce-ui:latest"` | UI Docker image. |
| `clone_max_idle_minutes` | `number` | `1440` | Leaked-clone reaper (DBLab `maxIdleMinutes`). Clones with active consumers never idle. |
| `logs_retention_days` | `number` | `3` | DBLab diagnostic log retention. |

### SSM, token, and extras

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `ssm_prefix` | `string` | `null` (→ `/<name>`) | SSM parameter namespace for the discovery parameters (`instance-id`, `host`, `verification-token`, `dbname`, `port-pool`) that the tendb CLI reads. |
| `token_secret_version` | `number` | `1` | Bump to rotate the API verification token. See [the rotation caveat](#token_secret_version) below before doing so. |
| `kms_key_id` | `string` | `null` | KMS key for the token SecureString. `null` uses the AWS-managed `aws/ssm` key. |
| `create_client_iam_policy` | `bool` | `false` | Materialize `client_iam_policy_json` as a managed IAM policy named `<name>-client`. |
| `sync_target_port` | `number` | `null` | Optional on-host sync-target Postgres port, opened to `allowed_cidr_blocks` only (streaming-source setups). Security-group-rule-only — no instance replacement. |
| `streaming_snapshots` | `bool` | `false` | Streaming-source mode: no scheduled dump/restore (retrieval runs `logicalSnapshot` only; `tendb-snapshotd` takes O(1) ZFS snapshots of the live sync target). Clones get `max_logical_replication_workers=0` so they can never compete with the sync target for the publisher's replication slot. See [Data refresh lifecycle](/concepts/data-refresh/). |
| `console_ingress` | `bool` | `false` | Open ports **80/443 to 0.0.0.0/0** for a console co-hosted on this instance (Caddy terminates TLS on the host). Security-group-rule-only — flipping it never touches user-data, so no instance replacement. |

:::caution
`console_ingress = true` opens 80 and 443 to the entire internet, not to `allowed_cidr_blocks`. That is by design — the co-hosted console's auth boundary is oauth2-proxy behind Caddy, not the network — but know what you are enabling.
:::

## Size presets

Preset values live in the module's `locals.tf`. Any per-knob input above overrides the corresponding preset value.

| Knob | `small` | `medium` | `large` | `xlarge` |
| --- | --- | --- | --- | --- |
| `instance_type` | `t3.medium` (4 GB) | `r6i.large` (16 GB) | `r6i.xlarge` (32 GB) | `r6i.2xlarge` (64 GB) |
| `root_volume_gb` | 16 | 20 | 20 | 20 |
| `data_volume_gb` | 20 | 100 | 200 | 2500 |
| `data_volume_iops` | gp3 baseline (3000) | gp3 baseline | gp3 baseline | 12000 |
| `data_volume_throughput` | gp3 baseline (125 MB/s) | gp3 baseline | gp3 baseline | 750 MB/s |
| Clone port pool | 6000–6009 (10 clones) | 6000–6019 (20 clones) | 6000–6039 (40 clones) | 6000–6049 (50 clones) |
| `shm_size` | `512mb` | `1g` | `2g` | `4g` |
| `dump_parallel_jobs` | 1 | 2 | 4 | 8 |
| `restore_parallel_jobs` | 1 | 2 | 4 | 8 |
| `shared_buffers` (per clone) | `256MB` | `512MB` | `1GB` | `1GB` |
| `work_mem` (per clone) | `32MB` | `64MB` | `64MB` | `128MB` |
| `maintenance_work_mem` (per clone) | `128MB` | `256MB` | `512MB` | `2GB` |

Two design notes baked into the presets:

- **Per-clone `shared_buffers` stays deliberately small at every size.** Clones share the host page cache / ZFS ARC, and N concurrent clones each allocate their own `shared_buffers` — scaling it with RAM would overcommit memory at full port-pool width.
- **`xlarge` is sized for a 200 GB–1 TB source.** Pool rule of thumb: dump + restored data + clone copy-on-write deltas ≈ 2.5× the source size (lz4 compression helps, but don't bank on it). At 1 TB the gp3 baselines would make restore crawl, hence the provisioned IOPS/throughput and restore parallelism matching the 8 vCPUs.

## Tuning knobs

### `instance_type`

Overrides the preset's EC2 type. Prefer memory-optimized (`r6i`) families — clone performance lives and dies on the host page cache and ZFS ARC. Changing it replaces the instance (any instance-type change does), which destroys the ZFS pool.

### `data_volume_gb`, `data_volume_iops`, `data_volume_throughput`

The data volume holds the ZFS pool: the restored source data, the logical dump (they share the pool), and every clone's copy-on-write deltas. Budget roughly 2.5× your source size. `null` IOPS/throughput means gp3 baselines (3000 IOPS, 125 MB/s) — fine up to `large`; provision both for big sources or restore times will crawl.

### `clone_port_range`

Each clone gets one port from this pool, so **the pool width is the hard cap on concurrent clones/branches**. The effective range is published to SSM as `<prefix>/port-pool` (the capacity readout `tendb status` uses). Widening it changes user-data — instance replacement.

### `postgres_configs`

Merged over the preset's settings; your keys win. The module always injects `shared_preload_libraries = "pg_stat_statements"` into the merge, so `pg_stat_statements` is preloaded in every size.

:::caution
If you supply your own `shared_preload_libraries`, it **silently replaces** the injected value — include `pg_stat_statements` in your list if you still want it.
:::

Remember these apply per clone: setting `shared_buffers = "2GB"` means every concurrent clone allocates 2 GB.

### `refresh_cron`

Standard cron expression for the full dump/restore refresh; default `0 2 * * *` (02:00 daily). DBLab skips the refresh non-destructively while clones exist, so long-lived branches delay data freshness rather than being destroyed. In `streaming_snapshots` mode the schedule is blanked — snapshots come from the streaming pipeline instead. Details in [Data refresh lifecycle](/concepts/data-refresh/).

### `dump_exclude_extensions`

Passes `--exclude-extension=<ext>` to `pg_dump` for each entry. Use it when the source runs provider-proprietary extensions that stock Postgres cannot install — the canonical example is Neon's `pg_session_jwt`. Without the exclusion, restore fails.

### `token_secret_version`

Bump this number to rotate the API verification token (it feeds the SSM parameter's `value_wo_version`). Two caveats:

- Clone passwords are derived from the token (`sha256(token:clone)`), so **existing clones keep passwords derived from the old token**.
- The host reads the token once at boot. Rotating the parameter alone does not reconfigure the running server — **the engine keeps honoring the old token until the instance is replaced**.

Rotate only when running clones are disposable, and plan for an instance replacement to complete the rotation.

## Outputs

| Output | Value | Intended consumer |
| --- | --- | --- |
| `instance_id` | Engine instance id | Operators, SSM targeting |
| `private_ip` | Host private IP | In-VPC clients, other modules |
| `public_ip` | Host public IP (empty unless `associate_public_ip`) | Operators |
| `security_group_id` | Engine security group id | Other modules granting themselves access via SG-to-SG rules |
| `instance_role_name` | Instance role name — attach extra policies here (e.g. additional secrets for future sync sources) | Root module extending host permissions |
| `instance_role_arn` | Instance role ARN | Trust and wiring |
| `ssm_prefix` | Effective SSM prefix (default `/<name>`) | CLI/CI configuration |
| `ssm_parameter_names` | Object with the full names of `instance_id`, `host`, `verification_token`, `dbname`, `port_pool` parameters — the tendb CLI's discovery contract | tendb CLI, CI |
| `api_port` | Always `2345` | Clients building tunnels and URLs |
| `clone_port_range` | Effective `{ from, to }` range | Clients; capacity readout |
| `client_iam_policy_json` | Rendered client policy JSON: tag-conditioned SSM session access plus discovery/token parameter reads | Attach to CI roles and operator groups |
| `client_iam_policy_arn` | Managed policy ARN when `create_client_iam_policy = true`, else `null` | CI/operator attachment |

### SSM discovery parameters

All parameters live under `ssm_prefix` (default `/<name>`):

| Parameter | Type | Written by | Content |
| --- | --- | --- | --- |
| `<prefix>/instance-id` | String | Terraform | Instance id. Its absence is the "platform is down" signal consumers rely on. |
| `<prefix>/host` | String | Terraform | Host private IP. |
| `<prefix>/verification-token` | SecureString | Terraform (write-only) | API token. Encrypted with `aws/ssm` unless `kms_key_id` is set. |
| `<prefix>/dbname` | String | The host, at boot | Source database name parsed from the URL. Terraform creates it as `"unknown"` and ignores value changes, so `terraform destroy` still cleans it up. |
| `<prefix>/port-pool` | String | Terraform | `"<from>-<to>"` — the clone capacity readout. |

:::note
If you pass a customer-managed `kms_key_id`, the module does **not** grant `kms:Decrypt` — you must grant it yourself, both to the instance role and to client principals.
:::

## Changes that replace the instance

The module sets `user_data_replace_on_change = true`, and the data volume has `delete_on_termination = true`. Put together:

:::danger
**Any change to the rendered user-data replaces the instance, which destroys the ZFS pool and every clone/branch on it.** Data re-syncs from the source at the next boot, but all branches are gone. Before applying, grep every plan for `must be replaced` — this module should never appear in that list unless you intend a rebuild.
:::

Variables that render into user-data — changing **any** of these replaces the instance:

- `server_image`, `clone_image`, `ui_image`, `ui_enabled`
- `refresh_cron`, `skip_start_refresh`, `streaming_snapshots`
- `clone_port_range`, `shm_size`, `postgres_configs`
- `dump_exclude_extensions`, `dump_parallel_jobs`, `restore_parallel_jobs`
- `clone_max_idle_minutes`, `logs_retention_days`
- `source_secret_arn`, `source_secret_json_key` — even cosmetic ARN changes (e.g. switching between the suffix-less and suffixed forms of the same secret) count
- `postgres_major_version`
- `ssm_prefix` and `name` (they feed the parameter names in user-data; renames also recreate the SG, role, and parameters)
- `size` — preset changes flow into port pool, shm, configs, and parallelism (plus the instance type itself)
- `ami_id` — and with `ami_id = null` the module tracks Canonical's *current* Ubuntu 24.04 AMI, so an upstream AMI bump alone can trigger replacement. **Pin `ami_id` on any deployment you care about.**
- `instance_type`, `root_volume_gb`, `data_volume_gb`, `data_volume_iops`, `data_volume_throughput` — volume/type changes replace the instance through the EC2 resource itself

Changes that are **safe** (never touch user-data or force replacement):

- `allowed_security_group_ids`, `allowed_cidr_blocks` — SG rules only
- `sync_target_port` — SG rule only
- `console_ingress` — SG rules only (this is deliberate, so a console can be added to a running engine)
- `tags`
- `create_client_iam_policy`
- `token_secret_version`, `kms_key_id` — SSM parameter only (but see [the rotation caveat](#token_secret_version))
- `ssm_access_tag_value` — instance tag and IAM condition only

## Boot behavior in brief

At first boot the host (all output logged to `/var/log/dblab-init.log` — the first place to look when smoke tests fail):

1. Installs Docker, ZFS, and the AWS CLI. This requires **outbound internet** (public IP or NAT) — the module provisions no VPC endpoints.
2. Creates the ZFS pool `dblab_pool` (lz4 compression) on the data volume, mounted at `/var/lib/dblab/dblab_pool`.
3. Fetches the verification token (SSM) and source URL (Secrets Manager) via the instance profile, outside the shell trace so neither reaches the log.
4. Publishes the parsed database name to `<prefix>/dbname`.
5. Writes DBLab's `server.yml` and starts `dblab_server` on port 2345, with the embedded UI on loopback port 2346.
6. Unless `skip_start_refresh` or `streaming_snapshots` is set, runs the initial dump/restore from the source.

For the full picture — including how the CLI consumes the discovery parameters and how refreshes are scheduled — see [Architecture](/concepts/architecture/) and [Data refresh lifecycle](/concepts/data-refresh/).
