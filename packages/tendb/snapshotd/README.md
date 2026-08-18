# tendb-snapshotd

The on-host executor behind `tendb snapshots create`, snapshot schedules, and
`tendb schema sync`. It polls the engine-contract param namespace (see
[`../terraform/docs/ENGINE-CONTRACT.md`](../terraform/docs/ENGINE-CONTRACT.md))
every ~5 s through a platform shim (`pf_get_param`/`pf_put_param`) and:

- **snapshot on request** — a new `snapshots/request` nonce triggers a
  CHECKPOINT of the streaming sync target (when configured), an O(1)
  `zfs snapshot dblab_pool@snapshot_<UTC ts>`, and an engine rescan restart.
  The CLI polls the snapshot listing and expects the new id within ~10 s.
- **schedule + retention** — `snapshots/config` (`intervalMinutes`, `retain`)
  drives periodic snapshots and pruning; snapshots with dependent
  branches/clones survive pruning (zfs refuses to destroy them).
- **schema reconcile** — a `schema/sync-request` nonce (or `schema/config`
  `autoSync` each ~minute, additive-only) heals DDL drift between the
  publisher and the sync target: missing tables created via
  `pg_dump --schema-only`, orphans dropped (full mode only), subscription
  publication refreshed.

## Deployment

| platform | mechanism |
|---|---|
| aws | SSM State Manager association (`modules/aws/engine/snapshotd.tf`) — no user_data change, reinstalls on instance replacement |
| gcp / azure | installed by the composed init template (`modules/common/engine-init`) |
| local | container built from `Dockerfile` (`modules/local/engine`) |

> **Behavioral reference caveat:** the daemon originally running on the live
> AWS host was hand-installed and is not in this repo. Before trusting this
> implementation there, capture the live copy and diff it:
> `aws ssm start-session --target <instance-id>` then
> `systemctl cat tendb-snapshotd; cat /usr/local/bin/tendb-snapshotd*`.
> The observable contract this version implements (poll tick, nonce
> semantics, `@snapshot_` naming, rescan restart) is derived from
> `cli/src/snapshots.ts` and `cli/src/schema-sync.ts`.
