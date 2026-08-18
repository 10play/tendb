---
title: The engine contract
description: The parameter namespace, ports, and derivations every tendb platform must publish identically.
---

Every platform provisions the same logical machine and must publish the
same discovery/control surface so the CLI, SDK, console, and
[`tendb-snapshotd`](/reference/snapshotd/) work identically everywhere.
This page is the condensed form; the authoritative version lives in the
repo at
[`packages/tendb/terraform/docs/ENGINE-CONTRACT.md`](https://github.com/10play/tendb/blob/main/packages/tendb/terraform/docs/ENGINE-CONTRACT.md).

## Discovery parameters

Published under `<prefix>` (default `/tendb`) by the platform's engine
module — except `dbname`, whose value the host writes at boot:

| Key | Secure | Value |
|---|---|---|
| `instance-id` | no | **Opaque tunnel target**: EC2 instance id (aws), `projects/<p>/zones/<z>/instances/<n>` (gcp), the VM resource id (azure), the engine container name (local). **Absence means platform down** — exit 10; `tendb ci delete` exits 0 |
| `host` | no | IP in-network clients dial for clone ports (`127.0.0.1` locally) |
| `verification-token` | yes | DBLab API token; written with write-only Terraform arguments wherever the provider supports one |
| `dbname` | no | Database name inside clones |
| `port-pool` | no | `"<from>-<to>"` — the width is the concurrent-clone capacity |
| `bastion-id` | no | **azure only**: the Bastion host resource id |

## Runtime namespaces

Read/written at runtime by the CLI, console, and snapshotd — never created
by Terraform, but platform IAM must permit them:

| Key | Secure | Meaning |
|---|---|---|
| `snapshots/config` | no | `{"intervalMinutes":0–10080,"retain":1–500}` (0 = manual) |
| `snapshots/request` | no | nonce `req-<epoch>-<hex8>` — a new value means "snapshot now" |
| `schema/config` | no | `{"autoSync":bool}` |
| `schema/sync-request` | no | nonce — a new value means "full schema sync now" |
| `alerts/slack-webhook` | yes | https URL, or the `"none"` sentinel |
| `console-url` | no | public console URL for Slack deep links; `"none"` sentinel |
| `replication/publisher-url` | yes | upstream publisher Postgres URL |
| `replication/subscriber-url` | yes | on-host sync target Postgres URL |

## Per-backend name mapping

The contract key `/tendb/snapshots/config` maps onto each store:

| Platform | Store | Mapping | Example |
|---|---|---|---|
| aws | SSM Parameter Store | verbatim | `/tendb/snapshots/config` |
| gcp | Secret Manager | strip leading `/`, then `/` → `_` | `tendb_snapshots_config` |
| azure | Key Vault | strip leading `/`, then `/` → `-` | `tendb-snapshots-config` |
| local | `params.json` | verbatim JSON keys | `/tendb/snapshots/config` |

The mapping is implemented twice — in the CLI (`mapParamName`) and in the
on-host shell shims — and golden-tested against this table.

## Ports and derivations

| Port | Role |
|---|---|
| 2345 | DBLab API |
| 2346 | DBLab embedded UI (bound to whatever host the platform's tunnel can reach — loopback on aws/local, the private IP on gcp/azure) |
| `port-pool` range | clone Postgres instances |
| 5433 | optional streaming sync target |

**Clone passwords** are derived, not stored:
`sha256("<verification-token>:<cloneId>")`, first 32 hex characters —
identical in the CLI (`naming.ts`) and any on-host script. Rotating the
token invalidates every running clone's password.
