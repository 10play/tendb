---
title: tendb-snapshotd
description: The on-host executor behind snapshots create, snapshot schedules, and schema sync — and how it is deployed per platform.
---

`tendb snapshots create` returning in ~10 seconds is this daemon's work.
`tendb-snapshotd` runs next to the engine, polls the
[contract namespace](/reference/engine-contract/) every ~5 s through the
platform shim, and executes what the params ask for:

- **Snapshot on request** — a new `snapshots/request` nonce triggers a
  `CHECKPOINT` of the streaming sync target (when one is configured), an
  O(1) `zfs snapshot dblab_pool@snapshot_<utc-ts>`, and an engine rescan
  restart (~2 s). The CLI polls the snapshot listing and expects the new id
  within ~10 s.
- **Schedule and retention** — `snapshots/config` drives periodic
  snapshots (`intervalMinutes`) and pruning (`retain`). Snapshots with
  dependent branches survive pruning: ZFS refuses to destroy them, which is
  exactly the guard wanted.
- **Schema reconcile** — a `schema/sync-request` nonce triggers a full
  heal of DDL drift between publisher and sync target (missing tables
  created via `pg_dump --schema-only`, orphans dropped, subscription
  publication refreshed); `schema/config.autoSync` runs the additive-only
  half every ~minute.

The daemon lives in the repo at `packages/tendb/snapshotd/` — one script,
a systemd unit, per-platform shims, and a Dockerfile.

## Deployment per platform

| Platform | Mechanism |
|---|---|
| aws | SSM State Manager association (`modules/aws/engine/snapshotd.tf`) — installs out of band, so the frozen user data is untouched, and re-installs automatically if the instance is ever replaced |
| gcp / azure | installed by the composed init template at boot |
| local | a privileged container (docker socket + `/dev/zfs` + the state dir) |

:::caution
The daemon originally running on the live AWS host was hand-installed and
predates this repo's copy. Before relying on the in-repo version there,
capture the live one and diff it — the exact command is in
[`packages/tendb/snapshotd/README.md`](https://github.com/10play/tendb/blob/main/packages/tendb/snapshotd/README.md).
The in-repo implementation was written to the CLI's observable contract
(poll tick, nonce semantics, `@snapshot_` naming, rescan restart).
:::
