---
title: "Terraform: network & console"
description: Reference for the tendb network and console Terraform modules and the three shipped examples — standalone, existing-vpc, and aurora-source.
---

Alongside the [engine module](/reference/terraform-engine/), the repo ships two supporting modules and three worked examples:

- **`modules/aws/network`** — a minimal VPC for greenfield deployments. Optional: skip it if you already have a VPC.
- **`modules/aws/console`** — a hosted web console behind Google login, running in-VPC next to the engine.
- **`examples/standalone`**, **`examples/existing-vpc`**, **`examples/aurora-source`** — copy-paste starting points for the three common topologies.

All modules require Terraform `>= 1.11` and AWS provider `~> 6.0`.

## Network module

Module path: `packages/tendb/terraform/modules/aws/network`. A thin wrapper around the community module `terraform-aws-modules/vpc/aws` (`~> 6.0`).

:::tip[When to skip it]
The engine module only needs a `vpc_id` and a `subnet_id`. If you already have a VPC, skip this module entirely and pass your own — that is exactly what the [existing-vpc example](#examplesexisting-vpc--engine-only-into-an-existing-vpc) does.
:::

### Modes

| Mode | What you get | Monthly cost |
| --- | --- | --- |
| `public` (default) | Public subnets + Internet Gateway, no NAT. The engine gets a public IP for **egress only** — Docker pulls, apt, dumping the source DB. Zero inbound exposure: the engine SG admits declared clients only, and admin access is SSM-only. | ~$3.65 (the public IP) |
| `private-nat` | Private subnets + a single NAT gateway, for orgs that prohibit public IPs. | ~$33 for the NAT **plus $0.045/GB** of processing on every nightly dump — a 100 GB nightly dump adds roughly $135/mo of NAT processing alone |

:::caution
`private-nat` bills NAT processing on every byte of every refresh. Accept the dump-processing cost consciously before choosing it over `public`.
:::

### Inputs

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | `"tendb"` | VPC name. |
| `cidr` | `string` | `"10.60.0.0/16"` | VPC CIDR. |
| `mode` | `string` | `"public"` | `"public"` or `"private-nat"` (validated). |
| `az_count` | `number` | `2` | How many availability zones to spread subnets across. |
| `tags` | `map(string)` | `{}` | Extra tags. |

Subnet layout with the default CIDR:

- **Public subnets** (always created, one per AZ): `10.60.100.0/24`, `10.60.101.0/24`, …
- **Private subnets** (only in `private-nat` mode): `10.60.0.0/20`, `10.60.16.0/20`, …

NAT is always a **single** gateway shared by all AZs — there is no per-AZ NAT HA option.

### Outputs

| Name | Value |
| --- | --- |
| `vpc_id` | The VPC id. |
| `vpc_cidr` | The CIDR — handy for the engine's `allowed_cidr_blocks`. |
| `engine_subnet_id` | Where the engine host should live: first private subnet in `private-nat` mode, first public subnet otherwise. |
| `subnet_ids` | All private subnets (`private-nat`) or all public subnets (`public`). |
| `associate_public_ip` | `true` in `public` mode — wire straight into the engine module's `associate_public_ip`. |

:::note
In `public` mode there are no private subnets at all — anything you deploy into this VPC lives in a public subnet. Also note the console module requires a **public** subnet (it terminates HTTPS itself), so `engine_subnet_id` only works for the console when the network runs in `public` mode.
:::

## Console module

Module path: `packages/tendb/terraform/modules/aws/console`. Hosts the tendb web console — the same server `tendb console` runs locally — on its own EC2 instance in-VPC next to the engine, behind Google login. See [The web console](/guides/console/) for what the console does.

<figure class="diagram">
<div class="scroll">
<svg viewBox="0 0 1210 300" role="img" aria-label="Hosted console request chain: the browser reaches Caddy over HTTPS, oauth2-proxy enforces Google login, and the tendb console dials the engine over direct in-VPC TCP — no SSM tunnels" font-family="ui-sans-serif, system-ui, sans-serif" font-size="13" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
<defs>
<marker id="terraform-network-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path d="M0 0 10 5 0 10z" fill="currentColor"/>
</marker>
</defs>
<rect x="24" y="150" width="104" height="56" rx="10" fill="none" stroke="currentColor" stroke-opacity="0.35" stroke-dasharray="6 5"/>
<text x="76" y="183" text-anchor="middle" font-weight="600">browser</text>
<line x1="128" y1="178" x2="228" y2="178" stroke="currentColor" stroke-width="1.5" marker-end="url(#terraform-network-arrow)"/>
<text x="164" y="168" text-anchor="middle">HTTPS</text>
<text x="196" y="40" font-size="11" letter-spacing="1.5" fill-opacity="0.6">VPC</text>
<rect x="192" y="48" width="994" height="228" rx="10" fill="none" stroke="currentColor" stroke-opacity="0.35" stroke-dasharray="6 5"/>
<rect x="216" y="76" width="700" height="176" rx="10" fill="currentColor" fill-opacity="0.03" stroke="currentColor" stroke-opacity="0.35"/>
<text x="232" y="104" font-size="14" font-weight="600">console host <tspan font-size="12" font-weight="400" fill-opacity="0.62">— its own EC2 instance</tspan></text>
<rect x="232" y="120" width="164" height="116" rx="8" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.22"/>
<text x="248" y="146" font-weight="600">Caddy</text>
<rect x="248" y="156" width="76" height="26" rx="13" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.25"/>
<text x="286" y="173" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11.5">:80/:443</text>
<text x="248" y="206" font-size="12" fill-opacity="0.62">automatic Let's Encrypt</text>
<line x1="396" y1="178" x2="464" y2="178" stroke="currentColor" stroke-width="1.5" marker-end="url(#terraform-network-arrow)"/>
<text x="432" y="168" text-anchor="middle" font-size="12">HTTP</text>
<rect x="468" y="120" width="176" height="116" rx="8" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.22"/>
<text x="484" y="146" font-weight="600">oauth2-proxy</text>
<rect x="484" y="156" width="114" height="26" rx="13" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.25"/>
<text x="541" y="173" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11.5">:4180 loopback</text>
<text x="484" y="206" font-size="12" fill-opacity="0.62">Google provider</text>
<text x="484" y="224" font-size="12" fill-opacity="0.62">email-domain allow-list</text>
<line x1="644" y1="178" x2="724" y2="178" stroke="currentColor" stroke-width="1.5" marker-end="url(#terraform-network-arrow)"/>
<text x="686" y="168" text-anchor="middle" font-size="11">authenticated</text>
<rect x="728" y="120" width="172" height="116" rx="8" fill="var(--sl-color-accent)" fill-opacity="0.06" stroke="var(--sl-color-accent)" stroke-opacity="0.7"/>
<text x="744" y="146" font-weight="600" fill="var(--sl-color-accent)">tendb console</text>
<rect x="744" y="156" width="144" height="26" rx="13" fill="var(--sl-color-accent)" fill-opacity="0.12" stroke="var(--sl-color-accent)" stroke-opacity="0.7"/>
<text x="816" y="173" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11.5" fill="var(--sl-color-accent)">:4400 loopback only</text>
<line x1="900" y1="178" x2="1026" y2="178" stroke="currentColor" stroke-width="1.5" marker-end="url(#terraform-network-arrow)"/>
<text x="968" y="168" text-anchor="middle" font-size="12">direct TCP</text>
<text x="968" y="196" text-anchor="middle" font-size="11" fill-opacity="0.62">no SSM tunnels</text>
<rect x="1030" y="146" width="132" height="64" rx="10" fill="currentColor" fill-opacity="0.03" stroke="currentColor" stroke-opacity="0.35"/>
<text x="1096" y="172" text-anchor="middle" font-weight="600">engine host</text>
<text x="1096" y="192" text-anchor="middle" font-size="12" fill-opacity="0.62">DBLab API <tspan font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">:2345</tspan></text>
</svg>
</div>
<figcaption>TLS ends at Caddy and identity at oauth2-proxy before a request reaches the console, which dials the engine directly in-VPC — no SSM tunnels.</figcaption>
</figure>

The DBLab verification token, clone credentials, and AWS access stay on the console host; the browser only ever sees the authenticated console UI. The host is a `t3.small` (by default) running Ubuntu 24.04, IMDSv2-only, no SSH — admin goes through SSM Session Manager. An Elastic IP gives it a stable address. Cost: roughly **$18/mo** (t3.small + EIP + 16 GB gp3).

The security group opens 80/443 to `0.0.0.0/0` by design — the auth boundary is oauth2-proxy, not the network.

### Prerequisites

Three one-time, manual steps before you can apply:

1. **A Google OAuth client** — created by hand in the Google Cloud console (Web application type; this step cannot be terraformed). Add `https://<domain>/oauth2/callback` as an authorized redirect URI (also available afterwards as the `oauth_redirect_uri` output). Store it in Secrets Manager as JSON:

   ```bash
   aws secretsmanager create-secret --name tendb/console-oauth \
     --secret-string '{"client_id":"...","client_secret":"..."}'
   ```

   The host pulls the secret at boot — it never transits Terraform state.

2. **A domain.** Either pass a Route53 `hosted_zone_id` (the module manages the A record), or create the record shown in the `required_dns_record` output at your DNS provider. Caddy retries certificate issuance until the name resolves.

3. **The tendb package.** Either run `pnpm pack` in the CLI package and pass the tarball path, or set `npm_package_spec = "@10play/tendb@x.y.z"`. Exactly one of the two must be set (validated).

### Inputs

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | `"tendb-console"` | Names the SG, role, instance profile, instance, and package bucket prefix. |
| `vpc_id` | `string` | — (required) | VPC for the console host. |
| `subnet_id` | `string` | — (required) | **Must be a public subnet** — the console terminates HTTPS itself on 80/443. |
| `instance_type` | `string` | `"t3.small"` | Node + Caddy + oauth2-proxy need more than 1 GB of RAM. |
| `tags` | `map(string)` | `{}` | Extra tags. |
| `domain` | `string` | — (required) | FQDN the console is served on. Also determines the OAuth redirect URI `https://<domain>/oauth2/callback`. |
| `hosted_zone_id` | `string` | `null` | Route53 zone for the A record. `null` means DNS is managed elsewhere — create the `required_dns_record` yourself. |
| `acme_email` | `string` | — (required) | Contact email for Let's Encrypt registration. |
| `oauth_secret_arn` | `string` | — (required) | Secrets Manager secret with the Google OAuth client JSON (`{"client_id": "...", "client_secret": "..."}`). Pulled by the host at boot. |
| `allowed_email_domains` | `list(string)` | `["10play.dev"]` | Google account domains allowed through (oauth2-proxy `--email-domain`). **Override this** — the default is 10play's own domain. |
| `oauth2_proxy_version` | `string` | `"7.8.1"` | oauth2-proxy release to install. |
| `package_tarball_path` | `string` | `null` | Local path to the `pnpm pack` output. Uploaded to a private S3 bucket, installed at boot, and updated in place. |
| `npm_package_spec` | `string` | `null` | npm spec to install instead of a tarball, e.g. `@10play/tendb@0.1.0`. Exactly one of `package_tarball_path` / `npm_package_spec` must be set. |
| `engine_ssm_prefix` | `string` | — (required) | The engine module's `ssm_prefix` output — the console discovers the engine host, token, and dbname from it. |
| `console_port` | `number` | `4400` | Loopback port the console server listens on behind oauth2-proxy. |

### Outputs

| Name | Value |
| --- | --- |
| `url` | `https://<domain>`. |
| `public_ip` | The EIP's public IP. |
| `instance_id` | Console instance id. |
| `security_group_id` | Pass into the engine's `allowed_security_group_ids` so the console can reach the API and clone ports. |
| `required_dns_record` | `"<domain>. 300 IN A <eip>"` when `hosted_zone_id` is `null`, else `null`. |
| `oauth_redirect_uri` | `https://<domain>/oauth2/callback` — add as an authorized redirect URI on the Google OAuth client. |

### Connecting the console to the engine

Two things must be true:

- **Discovery and credentials.** Pass `engine_ssm_prefix = module.engine.ssm_prefix`. The console re-reads `host`, `verification-token`, and `dbname` (plus optional `replication/*` URLs) from SSM on **every service start**, then dials the engine's DBLab API directly at `http://<engine-private-ip>:2345` — no SSM tunnels. Because the env is fetched at service start, a token rotation or engine replacement only needs `systemctl restart tendb-console` (via SSM) on the console host.
- **Network admission.** The engine's SG must admit the console: either the console's subnet is covered by the engine's `allowed_cidr_blocks` (the standalone example's VPC-CIDR rule covers this), or pass this module's `security_group_id` output into the engine's `allowed_security_group_ids`.

### Releases and instance replacement

In **tarball mode**, an on-host updater polls the package's S3 ETag every 15 seconds; when you repack and `terraform apply`, the new tarball is installed and the console restarted in place (~20 seconds) — no instance replacement, no certificate churn. In **npm mode** there is no updater: upgrading means changing `npm_package_spec`, which changes user-data and replaces the instance.

:::caution
The console instance has `user_data_replace_on_change = true`. Changing any variable rendered into user-data — `domain`, `acme_email`, `allowed_email_domains`, `console_port`, `oauth2_proxy_version`, or switching between tarball and npm delivery — **replaces the instance**: a fresh Let's Encrypt issuance, a new session cookie secret, and everyone re-authenticates. Nothing durable is lost, but plan access-list edits accordingly.
:::

## Examples

All three live under `packages/tendb/terraform/examples/`.

| Example | Choose it when |
| --- | --- |
| `standalone` | Fresh AWS account / greenfield. Network + engine, optionally a hosted console (dedicated instance or co-hosted on the engine). |
| `existing-vpc` | You already have a VPC and network posture; you only need the engine, with clients admitted by security group. |
| `aurora-source` | You are rehearsing (or templating) streaming sync where Aurora is the production source, feeding the engine by logical replication. |

:::danger
The checked-in `terraform.tfvars` files in `standalone` and `aurora-source` are the **maintainer's live stack pins** — real ARNs, AMI IDs, IPs, and 10play-specific domains. They are safe to commit (no secrets) but wrong for you. Replace every value before applying. The same goes for the default `allowed_email_domains = ["10play.dev"]`.
:::

### `examples/standalone` — greenfield network + engine (+ optional console)

Provisions:

- The **network module** with all defaults (`public` mode).
- The **engine module**, wired to the network outputs: `allowed_cidr_blocks = [module.network.vpc_cidr]` (in-VPC clients — the CLI tunnels via SSM regardless), `create_client_iam_policy = true`, plus pass-throughs for `size`, `postgres_major_version`, the source secret, `dump_exclude_extensions`, `sync_target_port`, `streaming_snapshots`, and `ami_id`.
- Optionally, a console in one of two hosting modes:
  - **Dedicated console** (`enable_console = true`): instantiates `modules/aws/console` as `<name>-console` in the network's engine subnet (public in the default network mode).
  - **Console-on-engine** (`console_on_engine = true`): the cheapest hosting — no second instance. Terraform owns a dedicated console EIP (held at the root so the URL, OAuth redirect, and certificate name survive stack changes), the package S3 bucket the on-host updater polls, and an extra IAM policy on the engine role (package read, OAuth secret read, and `ssm:PutParameter` on the console-writable subtrees). It also sets `console_ingress = true` on the engine, which opens 80/443 as SG rules without touching user-data. The console software itself is installed **out of band** over SSM by `terraform/scripts/engine-console-install.sh`, because the engine's user-data is frozen.

The source secret is created out of band so the URL never lands in Terraform state:

```bash
aws secretsmanager create-secret --name tendb/source-url \
  --secret-string 'postgres://user:pass@host:5432/dbname'
```

Key variables: `name` (`"tendb"`), `region` (`"eu-north-1"`), `size` (`"small"`), `postgres_major_version` (required), `source_secret_arn` (required), `source_secret_json_key`, `dump_exclude_extensions`, `enable_console`, `console_on_engine`, console wiring (`console_domain`, `hosted_zone_id`, `acme_email`, `oauth_secret_arn`, `allowed_email_domains`, `package_tarball_path`, `console_instance_type` — default `"t3.small"`), `sync_target_port`, `streaming_snapshots`, and `engine_ami_id`.

:::caution
Pin `engine_ami_id` for any deployment you keep. Left `null`, the engine tracks Canonical's *current* Ubuntu 24.04 AMI, and an AMI bump **replaces the engine and destroys the ZFS pool**. Likewise, pass the source secret ARN without the Secrets Manager random suffix — switching ARN forms later changes engine user-data and replaces the instance.
:::

Outputs: `instance_id`, `ssm_prefix` (point your `tendb.json`'s `ssmPrefix` here — see [Configuration](/reference/configuration/)), `cli_discovery` (the engine's `ssm_parameter_names` map), `client_iam_policy_arn`, `console_url`, `console_oauth_redirect_uri`, `console_public_ip`, `pkg_bucket`.

:::note
`scripts/engine-console-install.sh` is the maintainer's live migration script with hard-coded deployment constants (region, domain, bucket, email domain). It documents the console-on-engine runtime shape — including memory guardrails for the shared box (ZFS ARC capped at 1 GB, a 2 GB swapfile on the root volume, and a memory-capped console unit so the console dies before the engine ever does) — but you must edit its constants before reusing it.
:::

### `examples/existing-vpc` — engine-only into an existing VPC

Provisions just the **engine module** — no network, no console. It demonstrates the per-knob override pattern on top of a preset:

- `size = "small"` with `data_volume_gb = 50` and `postgres_configs = { work_mem = "48MB" }`
- A custom `ssm_prefix` (e.g. `/tendb-poc/dblab`) to stay compatible with an existing consumer fleet
- Clients admitted via `allowed_security_group_ids`; no public IP (the engine module's private-subnet defaults apply)

Variables: `name` (`"tendb"`), `region` (`"eu-north-1"`), `vpc_id` (required), `subnet_id` (required), `allowed_security_group_ids` (`[]`), `postgres_major_version` (required), `source_secret_arn` (required), `source_secret_json_key` (`null`), `ssm_prefix` (`null` → the engine default `/<name>`). Single output: `cli_discovery`.

Choose it when your network posture already exists, clients are other workloads identified by security group, or you need a nonstandard SSM prefix.

### `examples/aurora-source` — Aurora as the streaming source

A minimal, disposable Aurora Serverless v2 PostgreSQL cluster that plays the customer's production database and **streams every change into the engine via logical replication**. It has its own Terraform state — nothing in it touches the standalone example's resources.

```
Aurora (publisher) ── logical replication, seconds ──▶ sync-target Postgres
    (a postgres:18 container ON the engine host, :5433,
     data directory on the ZFS pool)
        │  zfs snapshot — O(1), seconds at any size
        ▼
    pool snapshots ──▶ branches (as-of-now via --fresh)
```

Aurora's storage engine permits no physical replication exit, so logical replication is the only streaming option. With `streaming_snapshots = true` on the engine, there is no dump/restore cycle at all — the engine host runs `tendb-snapshotd`, taking O(1) ZFS snapshots of the live sync target. See [Data refresh lifecycle](/concepts/data-refresh/).

**What it provisions:**

- An Aurora PostgreSQL cluster in the **default VPC**: Serverless v2 scaling `min_capacity = 0, max_capacity = 1`, one `db.serverless` writer with `publicly_accessible = true` (that is how the engine host's public IP and your operator machine reach it), `storage_encrypted`, `skip_final_snapshot`.
- A cluster parameter group setting `rds.logical_replication = "1"` (static parameter; a brand-new cluster picks it up on first provision — verify with `show wal_level`).
- A security group admitting 5432 from `client_cidrs` (engine host + hosted console) and `admin_cidrs` (operator access).
- An SSM SecureString `<engine_ssm_prefix>/replication/publisher-url` with the full publisher connection URL (`sslmode=require`) — published under the engine's prefix on purpose so the hosted console's existing read policy already covers it.

The 5433 sync-target ingress rule on the **engine's** SG is *not* created here — the engine module owns its SG rules exclusively. Set `sync_target_port = 5433` when applying the standalone example instead.

Variables: `name` (`"tendb-aurora-source"`), `region` (`"eu-north-1"`), `engine_version` (`"18.4"` — keep the major aligned with the subscriber), `database` (`"tendb"`), `engine_ssm_prefix` (`"/tendb"`), `client_cidrs` (`[]`), `admin_cidrs` (`[]`). Outputs: `endpoint`, `database`, `publisher_url_ssm_parameter`, `security_group_id`.

The example's `sql/` directory carries the wire-up pieces, and its README walks the ordered sequence: seed Aurora from the legacy source (`seed.sh`), create the publication and replication role on Aurora (`publisher.sql` — grants `rds_replication`, RDS's substitute for `REPLICATION`), run the sync-target container on the engine host, seed it from Aurora, subscribe it (`subscriber.sql`, `copy_data = false`), publish the subscriber URL to SSM yourself, and repoint the engine's source at the sync target. `loadgen.sh` generates demo traffic so you can watch changes flow.

:::caution
Three things to respect with this pipeline:

- **The engine host's IP is not an EIP.** After any engine stop/start, re-apply the example with the new IP in `client_cidrs` or replication cannot reconnect.
- **The cluster never auto-pauses** — the active replication slot holds a connection open despite the auto-pause setting. Budget roughly a $45/mo ceiling at 1 ACU, and `terraform destroy` when done rehearsing.
- **DDL does not replicate.** Apply schema changes on Aurora first, then on the sync target, then resume writes. And `copy_data = false` is only correct because the sync target was seeded from Aurora with nothing writing in between — breaking that ordering silently loses rows.
:::

:::note
Unlike the engine's source-secret discipline, this example's generated Aurora master password **does** live in its Terraform state — acceptable for a disposable rehearsal stack, not for production.
:::

## Cost summary

| Piece | Monthly cost |
| --- | --- |
| Network, `public` mode | ~$3.65 (public IP) |
| Network, `private-nat` mode | ~$33 + $0.045/GB of dump traffic (~$135 at 100 GB nightly) |
| Dedicated console | ~$18 (t3.small + EIP + 16 GB gp3) |
| Console-on-engine | $0 extra compute (shares the engine host; EIP only) |
| Aurora rehearsal stack | ~$45 ceiling at 1 ACU (never auto-pauses while the replication slot is active) |

Engine host costs depend on the [size preset](/reference/terraform-engine/#size-presets) you pick.
