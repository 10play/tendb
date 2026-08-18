---
title: Data refresh lifecycle
description: How tendb syncs data from your source Postgres — the first sync at boot, the nightly refresh, dump/restore mechanics, and how to control freshness.
---

Every branch you create is a copy-on-write thin clone of a ZFS snapshot on the engine host. That snapshot is produced by a **data refresh**: a logical `pg_dump` of your source database, a `pg_restore` into the ZFS pool, and a snapshot of the result. This page explains when refreshes run, what they do, why they sometimes *don't* run, and how to force one.

The refresh pipeline is DBLab Engine's retrieval subsystem (jobs `logicalDump → logicalRestore → logicalSnapshot`), configured by the tendb Terraform [engine module](/reference/terraform-engine/).

```
source Postgres (Neon / Aurora / RDS / any URL)
        │
        │  1. pg_dump  (parallel jobs per size preset)
        ▼
/var/lib/dblab/dblab_pool/dump ─────────┐
        │                               │
        │  2. pg_restore (parallel)     │  same ZFS pool
        ▼                               │  (lz4, gp3 EBS, dies with the host)
/var/lib/dblab/dblab_pool/data ─────────┘
        │
        │  3. zfs snapshot  ("data state at" timestamp)
        ▼
   snapshot ──► thin-clone branches (pr-42, my-feature, ...)
```

## First sync at boot

When the engine host boots, its cloud-init script (everything logs to `/var/log/dblab-init.log`) creates the ZFS pool, pulls the source connection URL from Secrets Manager via the instance profile, writes DBLab's `server.yml`, and starts the `dblab_server` container. The server then immediately runs a full refresh — dump, restore, snapshot — because `skipStartRefresh` defaults to `false`.

Until that first `logicalSnapshot` completes, there is nothing to branch from. `tendb branches create` handles this by waiting up to 15 minutes (`snapshotTimeoutSeconds`, default 900) for the first snapshot to appear:

```sh
tendb branches create smoke-test
# waits for the first snapshot if the engine is still restoring
```

If it times out with `no snapshot after 15m`, the first sync is still running (normal for large sources) or has failed — check `docker logs dblab_server` and `/var/log/dblab-init.log` on the host. See [Operations](/guides/operations/) for how to get there.

You can skip the boot-time sync with `skip_start_refresh = true`, but then no branches are possible until the first scheduled refresh runs. Leave it at the default unless you know why you need it.

## The nightly refresh: `refresh_cron`

`refresh_cron` (default `"0 2 * * *"` — daily at 02:00 on the engine's clock, UTC on a stock deployment) schedules a **full** refresh: a brand-new dump and restore, replacing the pool's data, followed by a new snapshot. New branches created after the refresh are copies of last night's production data.

```hcl
module "engine" {
  # ...
  refresh_cron = "0 2 * * 6"  # weekly, Saturday 02:00
}
```

:::caution
`refresh_cron` is interpolated into the host's user data, so changing it **replaces the EC2 instance** — destroying the ZFS pool and every branch on it (data re-syncs from source at boot). Plan the change like any [instance replacement](/guides/operations/#instance-replacement-semantics).
:::

In streaming-snapshot deployments (`streaming_snapshots = true`) the cron is blanked entirely: there is no dump/restore at all, and freshness comes from O(1) ZFS snapshots of the live sync target instead (`tendb snapshots create`, or `--fresh` on `branches create`). The rest of this page describes the default logical mode.

## The skip-while-clones-exist rule

A full refresh rewrites the pool's data directory — the dataset your branches are copy-on-write children of. Destroying it under running clones would kill them. So DBLab applies a simple, non-destructive rule:

> **A scheduled refresh is skipped while any clone exists.** Your branches survive; the refresh just doesn't happen.

How to reason about it:

- **The refresh only runs when the pool is empty of clones at cron time.** The "nightly fresh data" guarantee holds only if branches are ephemeral.
- **One long-lived branch pins the data forever.** A forgotten `pr-42` from last month means every *new* branch is also built from last month's snapshot.
- **CI hygiene is the fix, not a workaround.** Have CI run `tendb ci delete <pr>` when a PR closes (see [CI previews](/guides/ci-previews/)); the pool drains overnight and the 02:00 refresh goes through.
- **Idle branches reap themselves eventually.** The engine deletes clones idle longer than `clone_max_idle_minutes` (default 1440 = 24 h), so a leaked branch typically unblocks the next night's refresh on its own — but a branch something keeps connecting to never goes idle.

You can see the effect directly: `tendb status` shows `data state at` (the snapshot timestamp backing new branches), and `tendb checkup` raises a `data-stale` warning once the data is older than 26 hours (default threshold). Stale data with running clones listed in `tendb branches list` is this rule in action.

## Dump and restore mechanics

What actually runs during a refresh, and the switches that shape it:

- **Only the app database is dumped** — the one named in the source URL. Managed-Postgres roles (Neon, RDS, Aurora) can't dump system databases, and tendb doesn't try.
- **The dump lands on the same ZFS pool** as the restored data (`/var/lib/dblab/dblab_pool/dump`), which is why pool sizing budgets for both — see [the ~2.5× rule](/guides/operations/#zfs-pool-sizing-the-25-rule).
- **The connection to the source uses libpq defaults** (`sslmode=prefer`): TLS is negotiated when the source offers it, not enforced.
- **Restore runs with** `--no-tablespaces --no-privileges --no-owner --exit-on-error` and skips policies, because roles managed by your source provider don't exist on the engine host. `--exit-on-error` means a single failing object (for example, an extension that doesn't exist in stock Postgres — see [below](#excluding-provider-proprietary-extensions)) fails the whole restore.
- **The clone image's Postgres major must match the source's.** That's why the module's `postgres_major_version` variable has no default: it derives the clone image (`postgresai/extended-postgres:<major>-0.8.0`), and a mismatch fails restore.

### Parallelism per size preset

Dump and restore parallelism (`pg_dump -j` / `pg_restore -j`) scales with the size preset, alongside the memory Postgres gets for index builds:

| Preset | `dump_parallel_jobs` | `restore_parallel_jobs` | `maintenance_work_mem` | Data volume |
|---|---|---|---|---|
| `small` | 1 | 1 | 128MB | 20 GB, gp3 baseline |
| `medium` | 2 | 2 | 256MB | 100 GB, gp3 baseline |
| `large` | 4 | 4 | 512MB | 200 GB, gp3 baseline |
| `xlarge` | 8 | 8 | 2GB | 2500 GB, 12000 IOPS / 750 MB/s |

Both knobs are individually overridable (`dump_parallel_jobs`, `restore_parallel_jobs`) if your source tolerates more or less read pressure. Parallel dump and restore split work per table — one giant table serializes no matter how many jobs you give it.

## How long does a refresh take?

There are no universal numbers — it depends on your source's network throughput, row width, and index count — but you can bound it:

- The data crosses the network once (dump) and the pool disk at least twice (dump files written, restored data written), then indexes rebuild on CPU.
- At the gp3 baseline of 125 MB/s (small/medium/large presets), each 100 GB disk pass costs ~14 minutes of pure write time. The xlarge preset provisions 750 MB/s and 12000 IOPS precisely because at 1 TB the baseline would make restore crawl.

Rules of thumb, not benchmarks:

| Source size | Preset | Expect |
|---|---|---|
| A few GB | `small` | Minutes — dominated by fixed overhead |
| Tens of GB | `medium` | ~15–45 minutes |
| 100–200 GB | `large` | Roughly 1–3 hours |
| 500 GB–1 TB | `xlarge` | Several hours — sized to fit in an overnight window |

Index-heavy schemas and single huge tables push toward the top of each range. The practical test: the refresh must finish comfortably between `refresh_cron` and your team's morning. If it doesn't, raise the preset, or move to `streaming_snapshots` mode where "refresh" is an O(1) ZFS snapshot.

:::note
First sync at boot adds a few minutes of host setup (apt, AWS CLI, Docker image pulls) before the dump even starts.
:::

## Forcing fresh data

The refresh is scheduled, but you don't have to wait for it.

**1. Drain branches, then trigger a refresh.** No refresh runs while clones exist, so first:

```sh
tendb branches list
tendb branches delete my-feature   # for each running branch
```

Then either wait for the next cron tick, or trigger one now through the engine API:

```sh
# terminal 1: forward the DBLab API to localhost:2345
tendb tunnel

# terminal 2: fetch the token and trigger a full refresh
TOKEN=$(aws ssm get-parameter --name /tendb/verification-token \
  --with-decryption --query Parameter.Value --output text)
curl -X POST -H "Verification-Token: $TOKEN" http://localhost:2345/full-refresh
```

:::note
Not every DBLab 4.1.x build ships the `/full-refresh` endpoint — tendb's own client probes for it and treats a 404/405 as "not supported". If yours answers 404, use the cron or the instance-replacement route.
:::

**2. Replace the instance.** The heaviest option: `terraform apply -replace` on the engine's `aws_instance` rebuilds the host, and the boot sync pulls fresh data. Everything on the pool is destroyed. See [instance replacement](/guides/operations/#instance-replacement-semantics).

**3. Streaming mode only:** `tendb snapshots create` takes a new snapshot of the live sync target in seconds, and `tendb branches create <name> --fresh` does it inline — "main as of now" instead of "as of the last snapshot".

Note that `tendb branches reset <name>` does **not** fetch fresh source data — it recreates the clone from its branch's *existing* snapshot. Use it to throw away a branch's local writes, not to pick up last night's production changes.

## Excluding provider-proprietary extensions

Managed Postgres providers install proprietary extensions into your database. `pg_dump` faithfully records them — and then `pg_restore --exit-on-error` fails on the engine host, because the extension doesn't exist in stock Postgres or in the `postgresai/extended-postgres` clone image.

The canonical case is **Neon's `pg_session_jwt`** (used by Neon Auth). A Neon source with it installed fails restore until you exclude it:

```hcl
module "engine" {
  # ...
  dump_exclude_extensions = ["pg_session_jwt"]
}
```

Each listed extension becomes a `--exclude-extension=<name>` flag on `pg_dump`, so the extension (and its objects) never enter the dump.

Two cautions:

:::caution
Only exclude extensions your **application schema doesn't depend on**. If your tables use types or functions from an excluded extension, the restore breaks in a different way. Provider-auth plumbing like `pg_session_jwt` is safe; an extension your columns reference is not.
:::

:::caution
`dump_exclude_extensions` is interpolated into user data — changing it **replaces the instance** (pool and branches destroyed, data re-synced at boot). Get the list right at deploy time if you can; the symptom to watch for is a restore failure naming the extension in `docker logs dblab_server`.
:::

## Where to go next

- [Operations & troubleshooting](/guides/operations/) — reading `tendb status`/`tendb checkup`, and the failure table for broken refreshes.
- [Terraform: engine module](/reference/terraform-engine/) — every variable referenced here (`refresh_cron`, `skip_start_refresh`, `dump_exclude_extensions`, parallelism overrides).
- [Architecture](/concepts/architecture/) — how DBLab Engine, ZFS, and the branch model fit together.
