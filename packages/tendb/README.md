# tendb

Neon-style Postgres branching on your own AWS account, powered by
[DBLab Engine](https://postgres.ai) (ZFS thin clones). One EC2 host syncs from a
source Postgres database (Neon, Aurora, RDS, anything with a URL) and serves
copy-on-write branch databases in seconds — with a `neonctl`-style CLI, a local
web console, and a CI contract for PR preview environments.

```
tendb branches create my-feature     # copy-on-write branch DB, ready in ~5s
tendb psql my-feature                # auto SSM tunnel + psql
tendb console                        # Neon-style dashboard on localhost
tendb ci ensure 42 | tail -1         # CI: URI as the last stdout line
```

The package is self-contained: `terraform/` provisions the host, `cli/` is the
npm-publishable CLI + console. Extraction to its own repo is a single
`git mv packages/tendb/ <new-repo>/` — nothing in here references the parent repo.

## Architecture

```
                    AWS account
   ┌───────────────────────────────────────────────┐
   │  EC2 host (Ubuntu 24.04, ZFS on gp3)          │
   │  ┌─────────────────────────────────────────┐  │      nightly logical
   │  │ dblab-server :2345   embedded UI :2346  │◄─┼──── dump/restore ──── source
   │  │ clone :6000  clone :6001  clone :6002 … │  │      (any Postgres URL,
   │  └─────────────────────────────────────────┘  │       read from Secrets
   │        ▲ no SSH, no inbound internet          │       Manager at boot)
   └────────┼──────────────────────────────────────┘
            │ SSM Session Manager port-forwards
      ┌─────┴─────┐
      │ tendb  │  CLI / console / CI (discovers the host via SSM params,
      └───────────┘  derives clone passwords locally — stateless)
```

- **Discovery**: SSM parameters under a prefix (default `/<name>`):
  `instance-id`, `host`, `verification-token` (SecureString, never in TF state),
  `dbname` (published by the host at boot), `port-pool`.
  A missing `instance-id` = "platform is down" — `tendb ci delete` exits 0.
- **Credentials**: clone passwords are `sha256("<token>:<branch>")[0:32]` —
  derived on demand, stored nowhere, identical across CLI generations.
- **Transport**: the CLI calls the DBLab REST API through an SSM port-forward
  (spawning `session-manager-plugin` directly — no aws CLI needed). Direct
  `--api-url` mode skips AWS entirely for local/dev engines. The plugin is
  invoked with the same six-arg contract the aws CLI uses (StartSession
  response JSON, region, `StartSession`, profile, request params JSON, SSM
  endpoint) — de-facto, not documented; `cli/src/aws/session.ts` is the only
  place to fix if a plugin release breaks it.

## Quickstart (fresh AWS account)

The npm-native path — from any project, no repo clone:

```bash
npx @10play/tendb init     # scaffold terraform (git-pinned modules) + tendb.json
tendb up                   # secret preflight + terraform apply + config wiring
```

Or by hand:

```bash
# 1. The source URL lives in Secrets Manager (never in Terraform state):
aws secretsmanager create-secret --name tendb/source-url \
  --secret-string 'postgres://user:pass@host:5432/appdb'

# 2. Provision (network + host). Check your source's Postgres major first!
cd terraform/examples/standalone
terraform init && terraform apply \
  -var postgres_major_version=18 \
  -var source_secret_arn=<arn from step 1>

# 3. Point the CLI at it (repo root tendb.json):
#    { "ssmPrefix": "/tendb", "region": "eu-north-1" }
cd ../../../cli && pnpm install && pnpm build
node dist/index.js status          # wait for the first sync to finish
node dist/index.js branches create demo
```

Prereqs on the client: Node ≥ 20, `session-manager-plugin`
(`brew install --cask session-manager-plugin`), AWS credentials with the
module's `client_iam_policy_json` attached.

> **Maintainer note:** the live AWS resources were provisioned under the old
> `pgbranch` name (SSM prefix `/pgbranch`, secrets `pgbranch/console-oauth`
> and `pgbranch-smoke/source-url`). The config and terraform in this repo now
> use `tendb` — rename the AWS resources or re-apply terraform before the CLI
> can reach the engine again. The repo-root `tendb.json` points at that live
> engine (`/tendb`, eu-north-1).

## Sizes

| | small | medium | large | xlarge |
|---|---|---|---|---|
| source DB up to | ~10 GB | ~50 GB | ~100 GB | 200 GB–1 TB |
| instance | t3.medium (4 GB) | r6i.large (16 GB) | r6i.xlarge (32 GB) | r6i.2xlarge (64 GB) |
| ZFS pool | 20 GB | 100 GB | 200 GB | 2.5 TB |
| gp3 IOPS / throughput | baseline | baseline | baseline | 12k / 750 MB/s |
| max clones (port pool) | 10 | 20 | 40 | 50 |
| per-clone shared_buffers | 256 MB | 512 MB | 1 GB | 1 GB |
| dump/restore parallelism | 1 | 2 | 4 | 8 |

Pool sizing rule: dump + restored data + clone copy-on-write deltas ≈ **2.5×
the source size** (lz4 compression usually helps; don't bank on it). Every knob
is individually overridable (`instance_type`, `data_volume_gb`,
`clone_port_range`, `postgres_configs`, …) — see
[terraform/modules/engine](terraform/modules/engine/).

At xlarge scale, plan the refresh window consciously: a 1 TB logical
dump/restore takes hours, and a refresh is skipped (non-destructively) while
clones exist — schedule `refresh_cron` for a quiet window and keep branches
short-lived, or refresh less often than nightly.

## Caveats worth knowing (paid for in production)

- **Instance replacement destroys all clones.** Any `user_data` change replaces
  the host (`user_data_replace_on_change`); data re-syncs at boot. Treat clones
  as disposable, always.
- **Token rotation invalidates clone passwords.** Passwords derive from the
  verification token; bump `token_secret_version` only when running clones are
  disposable.
- **The clone image's Postgres major MUST match the source** — restore fails
  otherwise. `postgres_major_version` has no default for exactly this reason.
- **Provider-proprietary extensions break restore.** Neon's `pg_session_jwt`
  is the known case: pass `dump_exclude_extensions = ["pg_session_jwt"]`.
- **A data refresh is skipped while clones exist** (non-destructive). Delete
  branches before expecting fresh data at the next cron.

## Platforms

The same engine contract runs on four platforms
([terraform/docs/ENGINE-CONTRACT.md](terraform/docs/ENGINE-CONTRACT.md));
the CLI selects one via `platform` in tendb.json / `TENDB_PLATFORM` /
`--platform` (default `aws`):

| platform | host | params/secrets | tunnel | status |
|---|---|---|---|---|
| `aws` | EC2 + gp3/ZFS | SSM Parameter Store + Secrets Manager | SSM Session Manager | live |
| `gcp` | Compute Engine + pd-ssd/ZFS | Secret Manager | IAP TCP forwarding (`gcloud`) | validate-only |
| `azure` | Linux VM + managed disk/ZFS | Key Vault | Bastion Standard tunnel (`az`) | validate-only |
| `local` | Docker containers on a ZFS VM | `~/.tendb/local/params.json` | none (loopback) | verified e2e |

Local quickstart (macOS needs a colima VM — Docker Desktop's kernel has no ZFS):

```bash
bash terraform/modules/local/scripts/host-setup.sh   # colima + zpool preflight
export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock
terraform -chdir=terraform/examples/local init && terraform -chdir=terraform/examples/local apply
export TENDB_PLATFORM=local TENDB_STATE_DIR=$HOME/.tendb/local
tendb status && tendb branches create my-feature && tendb psql my-feature
```

GCP/Azure ship syntax/plan-validated, not yet applied anywhere: expect
first-apply issues. Caveats: GCP needs the IAP firewall range
(35.235.240.0/20) open to the tunneled ports and clients need
`roles/iap.tunnelResourceAccessor`; Azure requires a Standard-SKU Bastion
with native-client tunneling (~$140/mo idle) and an `AzureBastionSubnet`
/26; on both, config needs `gcpProject` / `azureVault` respectively.

## Repo layout

```
tendb/
├── terraform/
│   ├── docs/ENGINE-CONTRACT.md  # what every platform must publish
│   ├── modules/common/          # shared size presets + init templates
│   ├── modules/aws/             # engine / network / console (live)
│   ├── modules/gcp/             # engine / network / console (validate-only)
│   ├── modules/azure/           # engine / network / console (validate-only)
│   ├── modules/local/           # engine / console containers + VM preflight
│   └── examples/                # standalone, existing-vpc, aurora-source,
│                                #   local, gcp-standalone, azure-standalone
├── snapshotd/                   # on-host snapshot/schema executor + shims
└── cli/                         # @10play/tendb — CLI + console (see its README)
```

## Hosted console (optional)

`modules/console` deploys the same dashboard `tendb console` serves locally
as a team-accessible web app: Caddy (auto-HTTPS) → oauth2-proxy (**Google
login, restricted to `allowed_email_domains`**, default `10play.dev`) → the
console server, in-VPC next to the engine. Prereqs are a Google OAuth client
in Secrets Manager, a domain, and a `pnpm pack` tarball — see
[modules/console/README.md](terraform/modules/console/README.md). In the
standalone example it's one flag: `enable_console = true`.

## Extraction

```bash
git mv packages/tendb/ ../tendb-repo/   # or git filter-repo for history
```

Everything is self-referential (relative module sources, standalone
`package.json`/lockfile/tsconfig). Consumers that source the engine module by
relative path switch to a git source:
`source = "git::https://github.com/<org>/tendb.git//terraform/modules/engine?ref=v0.1.0"`.
