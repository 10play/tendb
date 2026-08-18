---
title: Architecture
description: How tendb serves Neon-style Postgres branches from a single EC2 host using DBLab Engine, ZFS thin clones, and SSM port-forwarding.
---

tendb is a thin layer of Terraform, AWS plumbing, and CLI ergonomics around [DBLab Engine](https://github.com/postgres-ai/database-lab-engine) (Database Lab Engine, by Postgres.ai) — the open-source engine that does the actual heavy lifting of snapshotting and thin-cloning Postgres on ZFS. One EC2 host in your AWS account syncs from your source database and serves copy-on-write branch databases. There is no control plane, no tendb service, and no state anywhere except the host itself.

<figure class="diagram">
<div class="scroll">
<svg viewBox="0 0 760 648" role="img" aria-label="tendb architecture: the CLI reaches the EC2 engine host only through SSM port-forwards; the host syncs outbound from the source Postgres and serves copy-on-write clones" font-family="ui-sans-serif, system-ui, sans-serif" font-size="13" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
<defs>
<marker id="arch-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path d="M0 0 10 5 0 10z" fill="currentColor"/>
</marker>
</defs>
<text x="44" y="24" font-size="11" letter-spacing="1.5" fill-opacity="0.6">YOUR LAPTOP / CI RUNNER</text>
<rect x="40" y="36" width="680" height="112" rx="10" fill="currentColor" fill-opacity="0.03" stroke="currentColor" stroke-opacity="0.35"/>
<text x="64" y="68" font-size="14" font-weight="600" fill="var(--sl-color-accent)">tendb CLI</text>
<text x="64" y="97">AWS SDK <tspan fill-opacity="0.55">→</tspan> SSM API <tspan fill-opacity="0.62">(GetParameter, StartSession)</tspan></text>
<text x="64" y="124"><tspan font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">session-manager-plugin</tspan> <tspan fill-opacity="0.62">— local port forwards</tspan></text>
<line x1="380" y1="148" x2="380" y2="234" stroke="currentColor" stroke-width="1.5" marker-end="url(#arch-arrow)"/>
<text x="396" y="180">outbound TLS to AWS SSM only</text>
<text x="396" y="198" fill-opacity="0.62">no inbound ports on the host</text>
<line x1="40" y1="216" x2="360" y2="216" stroke="currentColor" stroke-opacity="0.3" stroke-dasharray="6 6"/>
<line x1="400" y1="216" x2="614" y2="216" stroke="currentColor" stroke-opacity="0.3" stroke-dasharray="6 6"/>
<text x="720" y="220" text-anchor="end" font-size="11" letter-spacing="1.5" fill-opacity="0.6">AWS ACCOUNT</text>
<rect x="40" y="238" width="680" height="272" rx="10" fill="currentColor" fill-opacity="0.03" stroke="currentColor" stroke-opacity="0.35"/>
<text x="64" y="268" font-size="14" font-weight="600">EC2 engine host</text>
<rect x="60" y="282" width="640" height="36" rx="8" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.22"/>
<text x="76" y="305"><tspan font-weight="600">SSM agent</tspan> <tspan fill-opacity="0.62">— receives the port-forward sessions</tspan></text>
<rect x="60" y="330" width="640" height="86" rx="8" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.22"/>
<text x="76" y="356"><tspan font-weight="600">DBLab Engine</tspan> <tspan fill-opacity="0.62">(Docker — postgresai/dblab-server)</tspan></text>
<rect x="76" y="370" width="104" height="26" rx="13" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.25"/>
<text x="128" y="387" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11.5">API :2345</text>
<rect x="192" y="370" width="196" height="26" rx="13" fill="currentColor" fill-opacity="0.06" stroke="currentColor" stroke-opacity="0.25"/>
<text x="290" y="387" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11.5">UI 127.0.0.1:2346 <tspan fill-opacity="0.62">loopback</tspan></text>
<rect x="400" y="370" width="100" height="26" rx="13" fill="var(--sl-color-accent)" fill-opacity="0.12" stroke="var(--sl-color-accent)" stroke-opacity="0.7"/>
<text x="450" y="387" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11.5" fill="var(--sl-color-accent)">clone :6000</text>
<rect x="512" y="370" width="100" height="26" rx="13" fill="var(--sl-color-accent)" fill-opacity="0.12" stroke="var(--sl-color-accent)" stroke-opacity="0.7"/>
<text x="562" y="387" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11.5" fill="var(--sl-color-accent)">clone :6001</text>
<rect x="624" y="370" width="60" height="26" rx="13" fill="var(--sl-color-accent)" fill-opacity="0.12" stroke="var(--sl-color-accent)" stroke-opacity="0.7"/>
<text x="654" y="387" text-anchor="middle" font-size="11.5" fill="var(--sl-color-accent)">…</text>
<rect x="60" y="428" width="640" height="68" rx="8" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.22"/>
<text x="76" y="454"><tspan font-weight="600">ZFS pool </tspan><tspan font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">dblab_pool</tspan> <tspan fill-opacity="0.62">(dedicated gp3 EBS volume, lz4)</tspan></text>
<text x="76" y="479" fill-opacity="0.62">restored source data + logical dump</text>
<text x="356" y="479" fill="var(--sl-color-accent)">+ copy-on-write clone datasets — one per branch</text>
<line x1="380" y1="510" x2="380" y2="556" stroke="currentColor" stroke-width="1.5" marker-end="url(#arch-arrow)"/>
<text x="396" y="540" fill-opacity="0.62">outbound only — pg_dump</text>
<rect x="210" y="560" width="340" height="62" rx="10" stroke="currentColor" stroke-opacity="0.35" stroke-dasharray="6 5" fill="none"/>
<text x="380" y="586" text-anchor="middle" font-weight="600">source Postgres</text>
<text x="380" y="608" text-anchor="middle" font-size="12" fill-opacity="0.62">Neon · Aurora · RDS · any URL</text>
</svg>
</div>
<figcaption>One SSM-tunneled path in, one outbound sync path out — the host accepts no inbound connections.</figcaption>
</figure>

## The engine host

The Terraform [engine module](/reference/terraform-engine/) builds a single EC2 instance (Ubuntu 24.04 — chosen because ZFS is one `apt-get` away) with two volumes: a small gp3 root volume and a dedicated gp3 data volume that becomes a ZFS pool. At boot, the host installs Docker and ZFS, creates the pool, pulls the source database URL from Secrets Manager, writes a DBLab Engine config, and starts the `dblab_server` container.

Three sets of ports matter, and all of them stay inside your VPC:

| Port | What | Reachable how |
|---|---|---|
| `2345` | DBLab Engine REST API | SSM port-forward (or direct TCP if you open the security group) |
| `2346` | DBLab embedded UI | Bound to `127.0.0.1` on the host — SSM tunnel only, via `tendb ui` |
| `6000`–`6009`+ | Clone Postgres port pool | SSM port-forward per clone (or direct TCP if opened) |

Every branch database is a Postgres container listening on one port from the pool, so **the pool width is the hard cap on concurrent branches**. The default range depends on the module's `size` preset (10 ports for `small`, up to 50 for `xlarge`); grow it with the `clone_port_range` variable. `tendb status` reads the pool width from SSM and shows it as `clones n / cap`.

## ZFS copy-on-write thin clones

The restored source data lives in a ZFS dataset. Creating a branch takes a ZFS snapshot-and-clone of that dataset and starts a fresh Postgres container on top of it. Copy-on-write means:

- **Branch creation takes seconds**, regardless of database size. Nothing is copied — the clone initially shares every block with its parent snapshot.
- **A new branch consumes near-zero disk.** The pool only grows by the blocks a branch actually writes (its "CoW delta"). Ten branches of a 100 GB database do not cost 1 TB; they cost 100 GB plus whatever each branch changes.
- **Resetting a branch is cheap.** `tendb branches reset` throws the clone away and re-clones from the branch's snapshot — again in seconds.

Each clone is a full, writable, isolated Postgres. Writes on one branch never affect another branch or the source data.

:::note
The snapshot/clone/branch machinery is DBLab Engine's. tendb configures it, fronts it with an SSM transport, and adds the naming, password, and CI conventions on top.
:::

## Sync from source: logical dump/restore

tendb does **not** replicate from your source database by default. On a schedule (`refresh_cron`, default `0 2 * * *` — nightly at 02:00), the host runs a full logical refresh: `pg_dump` of the app database over the network into the ZFS pool, then `pg_restore` into the pool's data directory, then a fresh snapshot.

Consequences of the dump/restore model:

- It works against **any Postgres you can dial with a URL** — Neon, Aurora, RDS, self-hosted. No replication slots, no superuser, no logical decoding permissions on the source.
- Branches are point-in-time copies "as of the last refresh," not live followers. `tendb branches list` shows each branch's `DATA STATE AT` timestamp.
- A refresh is a full dump plus a full restore, so the data volume holds roughly the dump **and** the restored data (budget ~2.5× the source size).
- DBLab Engine skips a scheduled refresh non-destructively while clones exist, so a long-lived branch never gets yanked out from under you.

For sources where nightly staleness is not acceptable, the engine module also supports a streaming mode (`streaming_snapshots = true`) that keeps a live sync target on the host and takes O(1) ZFS snapshots of it instead of dump/restore cycles. See [Data refresh](/concepts/data-refresh/) for both modes in detail.

## Discovery: the SSM parameter contract

The CLI has no configuration ceremony because the Terraform module and the host publish everything a client needs as SSM parameters under a prefix (default `/tendb`). This is the discovery contract:

| Parameter | Type | Published by | Content |
|---|---|---|---|
| `<prefix>/instance-id` | String | Terraform | EC2 instance id of the engine host. **Its absence means "platform down"** — the CLI exits 10 and `tendb ci delete` treats it as "nothing to delete". |
| `<prefix>/host` | String | Terraform | The host's private IP. |
| `<prefix>/verification-token` | SecureString | Terraform (write-only value) | DBLab API token; also the input to clone password derivation. |
| `<prefix>/dbname` | String | **The host, at boot** | The source database name parsed from the source URL. Terraform creates the parameter as a placeholder and ignores value changes, so `terraform destroy` still cleans it up. |
| `<prefix>/port-pool` | String | Terraform | The clone port range as `"6000-6009"` — clients derive clone capacity from its width. |

A second group of parameters under the same prefix drives optional features; these are written by clients (the CLI, the console, or your Terraform) rather than being part of boot:

| Parameter | Written by | Purpose |
|---|---|---|
| `<prefix>/snapshots/config`, `<prefix>/snapshots/request` | `tendb snapshots` / console | Snapshot schedule and "snapshot now" nonce (streaming mode). |
| `<prefix>/schema/config`, `<prefix>/schema/sync-request` | `tendb schema` / console | Schema auto-heal flag and "full sync now" nonce (streaming mode). |
| `<prefix>/replication/publisher-url`, `<prefix>/replication/subscriber-url` | operator | Replication endpoints for sync status and `tendb checkup`. |
| `<prefix>/alerts/slack-webhook`, `<prefix>/console-url` | console | Slack alerting for the console. |

## Transport: SSM Session Manager port-forwards

The host accepts no inbound connections — by default its security group has **zero ingress rules**. Every byte between a client and the host travels through AWS Systems Manager Session Manager:

1. The CLI reads `<prefix>/instance-id` and calls `StartSession` with the AWS-managed document `AWS-StartPortForwardingSession`, targeting the host and a remote port (2345 for the API, a pool port for a clone).
2. It spawns the local `session-manager-plugin` binary (the same one the AWS CLI uses), which holds the WebSocket to AWS and listens on a local port.
3. The CLI polls the local port until it accepts TCP, then talks plain Postgres or HTTP through it.

One API tunnel (to 2345) opens per CLI session; clone tunnels open on demand — `tendb psql`, `tendb migrate`, and `tendb tunnel` each forward the specific clone port they need. Authorization is pure IAM: `ssm:StartSession` on the instance (tag-conditioned) and on the port-forwarding document. No VPN, no bastion, no security-group changes.

:::tip
The `session-manager-plugin` binary must be on your `PATH` (`brew install --cask session-manager-plugin` on macOS). If it's missing, the CLI fails fast with exit code 5 and an install hint.
:::

Direct TCP is available as an opt-in for in-VPC clients (CI runners in the same VPC, the hosted console): the module's `allowed_security_group_ids` / `allowed_cidr_blocks` variables open 2345 and the clone port range, and the CLI's `--api-url` mode skips AWS entirely.

## The stateless CLI

`tendb` keeps no state — no local database, no session files, no server-side registry of branches. Every command reconstructs the world from two sources: the SSM parameters above and the DBLab Engine API. That design shows up everywhere:

- **Deterministic credentials.** A clone's Postgres password is derived as `sha256("<token>:<branch>")` truncated to 32 hex characters, and its username is the branch name with dashes turned to underscores. Any machine with IAM access to read the token can compute the connection string for any branch — nothing to look up, nothing to store. (See [Security](/concepts/security/) for the implications.)
- **Idempotent workflows.** `tendb branches create` is create-or-reuse: an already-running clone short-circuits, a wedged one is deleted and recreated. `tendb ci delete` exits 0 when the branch — or the whole platform — is already gone.
- **Interchangeable clients.** The CLI, the SDK, the console, and CI all speak the same contract, so a branch created in CI is immediately visible and connectable from a laptop.
- **`tendb.json` is configuration, not state.** It only holds pointers (SSM prefix, region, profile, environments) and can be reconstructed from scratch.

Names are load-bearing in this model: a branch name is simultaneously the DBLab branch name, the clone id, and (dash→underscore) the Postgres role name, so names must match `[a-z0-9][a-z0-9-]*` (max 63 chars). A bare number is CI shorthand: `tendb branches create 42` creates `pr-42`.

## Where to go next

- [Security](/concepts/security/) — the IAM, token, and secret model in depth.
- [Data refresh](/concepts/data-refresh/) — dump/restore vs. streaming snapshots.
- [Terraform engine module](/reference/terraform-engine/) — every input and output.
- [CLI reference](/reference/cli/) — all commands and exit codes.
