---
title: Operations & troubleshooting
description: The day-2 runbook — reading status and checkup, rotating the token, replacing and resizing the host, pool sizing, and fixes for common failures.
---

tendb is a single EC2 host running DBLab Engine, discovered through SSM parameters. Day-2 operations reduce to a small set of moves: read the two health commands, know which Terraform changes replace the host, and treat branches as disposable. This page is the runbook.

## Reading `tendb status`

`tendb status` is your first stop. It calls the engine's health and status endpoints and reads the port-pool SSM parameter, then prints one row per fact:

| Row | Meaning | What to look for |
|---|---|---|
| `health` | `ok` or `UNREACHABLE` (engine `/healthz`) | `UNREACHABLE` → engine container down or tunnel broken |
| `engine` | DBLab server version | Should match your pinned `server_image` |
| `transport` | `ssm (i-…)` or `direct` | Confirms which host you're actually talking to |
| `sync mode` | Retrieval mode (logical dump/restore vs streaming) | Should match your Terraform config |
| `sync status` | Whether a refresh is running right now | A refresh "running" for hours on a small source is a stuck refresh |
| `last refresh` / `next refresh` | Engine's refresh timestamps and schedule | `next refresh` in the past that never fires → clones are blocking it |
| `data state at` | Timestamp of the snapshot backing new branches | Older than ~a day → see [stale data](#stale-data-clones-block-the-refresh) |
| `disk` | ZFS pool usage: `X.XG used / Y.YG (Z.ZG free)` | Compare against the 80% / 92% checkup thresholds |
| `clones` | `n / cap` — running clones vs port-pool capacity | Near cap → deletes needed before new branches fit |

Running clone ids are listed on stderr. Use `-o json` for machine-readable output (`{ healthy, transport, instanceId, engineVersion, retrieving, pools, clonesUsed, cloneCapacity }`).

## Reading `tendb checkup`

`tendb checkup` evaluates a fixed rule set and prints findings, one per row: `severity code message`. Healthy output is `health  ok — no findings`. It exits `1` if any **critical** finding exists (with `--strict`, any finding at all), so it drops straight into CI schedules or cron.

| Code | Severity | Fires when |
|---|---|---|
| `engine-unreachable` | critical | `/healthz` fails |
| `sync-alerts` | warning | The engine reports retrieval alerts |
| `data-stale` | warning | Newest snapshot older than 26 h (2 h when streaming replication is configured) |
| `disk-usage` | warning / critical | Pool above 80% / 92% |
| `clone-capacity` | warning / critical | Port pool above 80% used / full |
| `replication-publisher` / `replication-subscriber` | critical | A replication endpoint doesn't answer (streaming setups) |
| `subscription-disabled` | critical | The subscriber's subscription is disabled |
| `replication-errors` | warning | Apply/sync error counters rising |
| `slot-inactive` | warning | Publisher slot has no active consumer |
| `replication-lag` | warning | Slot lag above 50 MiB |
| `replication-stale` | warning | No replication progress for 300 s |
| `schema-drift` | warning | Publisher and subscriber schemas diverge |

The replication and schema codes only apply to streaming deployments; a plain nightly-dump deployment normally only ever sees the first five.

For continuous monitoring, the [web console](/guides/console/) runs this same checkup every 60 seconds and can push findings to Slack; the SDK's `watch()` + `slackSink` does the same from your own process.

## Getting onto the host

There is no SSH. Admin access is SSM Session Manager, keyed off the instance id published at `<ssm_prefix>/instance-id` (default prefix `/tendb`):

```sh
INSTANCE=$(aws ssm get-parameter --name /tendb/instance-id \
  --query Parameter.Value --output text)
aws ssm start-session --target "$INSTANCE"
```

:::note
The tendb **client** IAM policy only grants port-forwarding and `AWS-RunShellScript` — enough for the CLI and for one-off diagnostics via `aws ssm send-command`, but an *interactive* shell session needs broader SSM permissions on your own principal.
:::

The two logs that answer most questions:

- **`/var/log/dblab-init.log`** — the entire boot script's output: pool creation, secret fetch, first sync kickoff. First stop when a fresh deploy doesn't come up.
- **`docker logs dblab_server`** — the engine itself: dump/restore progress and errors, clone provisioning, refresh scheduling.

## Token rotation

The API verification token lives in SSM (`<ssm_prefix>/verification-token`) and does double duty: it authenticates every API call, and **every clone's Postgres password is derived from it** (`sha256(token:clone)`). That makes rotation a bigger event than it looks.

**Blast radius of a rotation:**

1. The new token is written to SSM immediately on `terraform apply`.
2. The running server keeps the **old** token — it read it once, at boot. Until the instance is replaced, the CLI (which reads the new token from SSM) fails to authenticate.
3. Every existing clone keeps its password derived from the old token — the CLI can no longer compute it.
4. Replacing the instance destroys the ZFS pool and every branch, then re-syncs from source at boot.

In short: **rotation implies instance replacement, and instance replacement implies losing all branches.** Rotate only when running branches are disposable.

**Procedure:**

```sh
# 1. Drain branches (CI will recreate its own on the next run)
tendb branches list
tendb branches delete <name>   # for each

# 2. Bump the version and replace the host in one apply
#    (adjust the module path to your root module)
```

```hcl
module "engine" {
  # ...
  token_secret_version = 2   # was 1
}
```

```sh
terraform apply -replace='module.engine.aws_instance.this'

# 3. Wait for boot + first sync, then verify
tendb status
```

The `-replace` is required: bumping `token_secret_version` alone rewrites the SSM parameter but does not touch user data, so Terraform will *not* replace the instance for you — leaving you in the broken in-between state of step 2 above.

## Instance replacement semantics

The engine module sets `user_data_replace_on_change = true`, and the boot template is frozen: **any change to a value interpolated into user data replaces the EC2 instance.** The data volume has `delete_on_termination = true`, so replacement destroys the ZFS pool — the dump, the restored data, and every branch. This is by design: the host is cattle, the source database is the source of truth, and a fresh host re-syncs at boot.

Changes that **replace** the host (not exhaustive — always check the plan):

- `size`, `instance_type`, volume sizes/IOPS/throughput
- `server_image`, `clone_image`, `ui_image`, `postgres_major_version`
- `refresh_cron`, `skip_start_refresh`, `dump_exclude_extensions`, `dump_parallel_jobs`, `restore_parallel_jobs`
- `clone_port_range`, `shm_size`, `postgres_configs`, `clone_max_idle_minutes`, `logs_retention_days`
- `source_secret_arn`, `source_secret_json_key`, `ssm_prefix`, `streaming_snapshots`

Changes that are **safe** (no user-data impact):

- `allowed_security_group_ids`, `allowed_cidr_blocks`, `console_ingress`, `sync_target_port` (security-group rules only)
- `tags`, `create_client_iam_policy`

:::caution
Grep every plan for `must be replaced` before applying. If the engine instance appears there and you didn't intend a rebuild, stop. If you did intend it: what you lose is the branches and any writes inside them; what survives is the source data, the SSM discovery contract, and client IAM access (it's conditioned on the instance's `Role` tag, not its id, precisely so it survives replacement).
:::

Expected downtime for a replacement = boot (a few minutes) + first sync (see [refresh durations](/concepts/data-refresh/#how-long-does-a-refresh-take)). `tendb ci delete` exits 0 while the platform is down, so PR-close jobs won't fail mid-replacement; `tendb ci ensure` will fail with exit 10 until the host is back.

## Resizing between presets

Moving `size = "medium"` → `"large"` changes the instance type *and* user data (port pool, shm size, Postgres configs, parallel jobs), so it is always a replacement:

1. Pick a window where losing branches is acceptable (branches are ephemeral in a healthy setup, so any night works).
2. Change `size` (or individual overrides like `data_volume_gb` — treat those as replacements too, and confirm in the plan).
3. `terraform apply`, confirm the instance shows as `must be replaced` and nothing else surprising does.
4. Watch the rebuild: `tendb status` until `health ok`, or tail `/var/log/dblab-init.log` on the host.
5. CI resumes on its own — the next `tendb ci ensure` recreates branches from the fresh sync.

Preset capacities for reference: small = 10 clones, medium = 20, large = 40, xlarge = 50 (the clone cap is the port-pool width).

## ZFS pool sizing: the ~2.5× rule

The data volume holds three things at once: the compressed logical **dump**, the **restored** database, and the copy-on-write **deltas** your branches accumulate. Budget:

```
data_volume_gb ≈ 2.5 × source database size
```

lz4 compression helps, but don't bank on it. The presets already follow this rule (e.g. `large` = 200 GB volume for up-to-100 GB sources; `xlarge` = 2.5 TB for up-to-1 TB sources). Watch the `disk` row in `tendb status`; `tendb checkup` warns at 80% and goes critical at 92%. An undersized pool fails in the worst place — mid-refresh, when dump and restore coexist at their peak.

## Common failures

| Symptom | Cause | Fix |
|---|---|---|
| Restore fails; `docker logs dblab_server` shows a Postgres version/format mismatch | `postgres_major_version` doesn't match the source's actual major — the clone image major **must** match or restore fails | Set `postgres_major_version` to the source's major and apply (replacement + re-sync) |
| Restore fails on `CREATE EXTENSION pg_session_jwt` (or another provider extension) | Source is managed Postgres with a proprietary extension that stock Postgres can't install; `--exit-on-error` aborts the restore | Add it to `dump_exclude_extensions` (replacement). See [excluding extensions](/concepts/data-refresh/#excluding-provider-proprietary-extensions) |
| `error: session-manager-plugin not found on PATH` (exit 5) | The AWS Session Manager plugin isn't installed on the machine running the CLI | macOS: `brew install --cask session-manager-plugin`; Ubuntu: install the `.deb` from AWS |
| `error: psql not found on PATH` (exit 5) | `tendb psql` needs a local psql binary | `brew install libpq` (or `postgresql`) |
| `error: DBLab host not found (/tendb/instance-id missing — platform down?)` (exit 10) | The `instance-id` SSM parameter is absent — the platform is destroyed/not yet applied, or you're pointed at the wrong region/`--ssm-prefix` | Bring the platform up (`terraform apply`); otherwise check `--region`/`--ssm-prefix` and your AWS profile |
| Branches keep serving day-old (or week-old) data; `checkup` shows `data-stale` | Running clones block the scheduled refresh — it's skipped non-destructively while any clone exists | Delete idle branches (`tendb branches list`, `tendb branches delete`); make CI delete on PR close. See [the skip rule](/concepts/data-refresh/#the-skip-while-clones-exist-rule) |
| `error: clone capacity exhausted…` (exit 42) | Port pool is full — every port in `clone_port_range` has a clone | Delete idle branches; for a durably bigger fleet, raise `clone_port_range` or the `size` preset (replacement) |
| `error: no snapshot after 15m` (exit 4) on the first `branches create` | First sync still running (normal for large sources) or failed | Check `docker logs dblab_server` and `/var/log/dblab-init.log`; retry once `tendb status` shows a `data state at` |
| CLI suddenly gets auth errors after a Terraform apply | `token_secret_version` was bumped without replacing the instance — SSM has the new token, the server still runs the boot-time one | Complete the [rotation procedure](#token-rotation) with `-replace` |
| `tendb tunnel` exits 1 mid-session | The SSM session hit its duration limit or the plugin died — foreground tunnels deliberately exit 1 so scripts notice | Rerun the tunnel; long-lived consumers should respawn on nonzero exit |
| `error: verification token not found at /tendb/verification-token` (exit 10) | Partial teardown or wrong `--ssm-prefix` | Re-apply Terraform, or point the CLI at the right prefix |

For the full exit-code table and every error message with its hint, see the [CLI reference](/reference/cli/).

## Where to go next

- [Data refresh lifecycle](/concepts/data-refresh/) — the sync pipeline these operations revolve around.
- [Terraform: engine module](/reference/terraform-engine/) — every variable named above.
- [Security model](/concepts/security/) — why there's no SSH, and what the token protects.
