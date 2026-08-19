# The tendb Engine Contract

Every platform (aws, gcp, azure, local) provisions the same logical machine —
a DBLab Engine host — and must publish the same discovery/control surface so
the CLI, SDK, console, and `tendb-snapshotd` work identically everywhere.
This document is the source of truth; the CLI's `mapParamName`
(`cli/src/platform/index.ts`) and each platform's init shim implement it and
are golden-tested against it.

## Discovery parameters

Published under `<prefix>` (default `/tendb`) by the platform's engine module
(except `dbname`, whose value the host writes at boot):

| key | secure | value |
|---|---|---|
| `instance-id` | no | **Opaque tunnel target** for the platform adapter: EC2 instance id (aws), `projects/<p>/zones/<z>/instances/<n>` (gcp), the VM's ARM resource id (azure), the engine container name (local). **Absence means the platform is down** — the CLI raises `PlatformDownError` (exit 10) and `tendb ci delete` exits 0. |
| `host` | no | IP that in-network clients dial for clone ports. The host's private IP on cloud platforms (written by init via `pf_self_ip`); `127.0.0.1` locally. |
| `verification-token` | yes | DBLab API token. Written by terraform with a write-only argument wherever the provider supports one, so it stays out of state (aws: `value_wo`; gcp: `secret_data_wo`; azure: `value_wo`; local: plain resource — dev-machine state, documented). |
| `dbname` | no | Database name inside clones. Terraform creates the parameter with a placeholder and ignores value changes; the host parses the source URL at boot and overwrites it (local: terraform parses `source_url` directly). |
| `port-pool` | no | `"<from>-<to>"` (e.g. `6000-6009`). The width is the concurrent-clone capacity; must match `server.yml`'s `provision.portPool` and the platform's firewall rules. |
| `bastion-id` | no | **azure only**: the Bastion host's ARM resource id; the CLI parses name + resource group from it to spawn `az network bastion tunnel`. |

## Runtime namespaces

Not created by terraform; read/written at runtime by the CLI, console, and
`tendb-snapshotd`. Platform IAM must permit them.

| key | secure | writer → reader |
|---|---|---|
| `snapshots/config` | no | `{"intervalMinutes":<0..10080>,"retain":<1..500>}` (0 = manual). CLI/console → snapshotd |
| `snapshots/request` | no | nonce `req-<epoch>-<hex8>`; any new value means "snapshot now". CLI/console → snapshotd |
| `schema/config` | no | `{"autoSync":<bool>}`. CLI/console → snapshotd |
| `schema/sync-request` | no | nonce `sync-<epoch>-<hex8>`; any new value means "full schema sync now". CLI/console → snapshotd |
| `schema/sync-result` | no | `{"nonce":<request nonce>,"ok":true}` or `{"nonce":...,"ok":false,"error":"..."}`; the daemon's answer to the last sync-request, matched by nonce so stale answers are ignored. snapshotd → CLI/console |
| `alerts/slack-webhook` | yes | https URL, or the literal `"none"` sentinel (stores may not accept empty values). console ↔ console |
| `console-url` | no | public console URL for Slack deep links; `"none"` sentinel. operator → console |
| `replication/publisher-url` | yes | full Postgres URL of the upstream publisher. terraform/operator → CLI/console |
| `replication/subscriber-url` | yes | full Postgres URL of the on-host sync target. operator → CLI/console |

## Param-name mapping per backend

The contract key (e.g. `/tendb/snapshots/config`) maps onto each store:

| platform | store | mapping | example |
|---|---|---|---|
| aws | SSM Parameter Store | verbatim | `/tendb/snapshots/config` |
| gcp | Secret Manager | strip leading `/`, then `/` → `_` | `tendb_snapshots_config` |
| azure | Key Vault | strip leading `/`, then `/` → `-` | `tendb-snapshots-config` |
| local | `<stateDir>/params.json` | verbatim JSON keys | `/tendb/snapshots/config` |

Contract leaves never contain `_`, so the gcp mapping is unambiguous. The
azure mapping is theoretically ambiguous (`-` also appears in leaves); it is
collision-free for the fixed contract vocabulary above — do not add keys that
would collide. On gcp every param is a secret (one store, one IAM surface;
the `secure` flag is a no-op); same on azure.

## Ports

| port | role |
|---|---|
| 2345 | DBLab API (published on the host / loopback locally) |
| 2346 | DBLab embedded UI (host loopback only; reached via tunnel) |
| `port-pool` range | clone Postgres instances |
| 5433 | optional streaming sync target Postgres |

## Clone password derivation

`sha256("<verification-token>:<cloneId>")` hex, first 32 chars — implemented
in `cli/src/naming.ts` and in any on-host script that mints clone
credentials. Do not change one without the other.

## Init responsibilities (every VM platform)

1. Create/verify zpool `dblab_pool` mounted at `/var/lib/dblab/dblab_pool`
   (compression=lz4, atime=off) with `data/` and `dump/` subdirs.
2. Fetch the verification token (param store) and source URL (secret store)
   using the platform's machine identity — never through terraform values.
3. Parse the source URL robustly (python `urllib.parse`; URL-encoded
   passwords survive) and publish `dbname` (param store + `/var/lib/dblab/dbname`).
4. Determine the reachable self IP (`pf_self_ip`) for `cloning.accessHost`.
5. Render `/root/.dblab/engine/configs/server.yml` (0600).
6. Run `postgresai/dblab-server` with `--privileged`, the docker socket, the
   `/var/lib/dblab` mount `rshared`, publishing 2345.
7. Install and start `tendb-snapshotd` with the platform shim at
   `/etc/tendb/platform-shim.sh`.

The platform shim contract (sourced by init-core and snapshotd):

```bash
pf_get_secret <id>          # secret-store read → stdout (source URL)
pf_get_param <leaf>         # param read → stdout, non-zero/empty if absent
pf_put_param <leaf> <value> # param write
pf_self_ip                  # primary private IP → stdout
pf_data_device              # block device path for the ZFS pool → stdout
```

`pf_get_param`/`pf_put_param` take contract *leaves* relative to the prefix
(`verification-token`, `snapshots/request`); the shim joins them with
`TENDB_PARAM_PREFIX` and applies the platform name mapping internally. The
CLI-side equivalent (`mapParamName`) takes the full contract name.
