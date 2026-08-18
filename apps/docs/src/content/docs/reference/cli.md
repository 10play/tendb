---
title: CLI reference
description: Every tendb command — synopsis, arguments, flags with defaults, behavior, exit codes, and examples.
---

The `tendb` CLI ships in the npm package [`@10play/tendb`](https://www.npmjs.com/package/@10play/tendb). It requires Node.js 20 or newer.

```bash
npm install -g @10play/tendb
tendb --version
```

Every command talks to the DBLab Engine API on your engine host — by default through an AWS SSM port-forwarding session (no open ports, no SSH keys), or directly with [`--api-url`](/reference/configuration/#direct-mode---api-url). Configuration comes from flags, `TENDB_*` environment variables, and `tendb.json` — see the [configuration reference](/reference/configuration/).

## Global conventions

### Global flags

These flags work on every leaf command:

| Flag | Default | Meaning |
|---|---|---|
| `--env <name>` | — | Select an environment block from `tendb.json` |
| `--region <region>` | — | AWS region |
| `--profile <profile>` | — | AWS profile (loaded via the shared credentials file) |
| `--ssm-prefix <prefix>` | `/tendb` | SSM parameter prefix |
| `--instance-id <id>` | — | DBLab host instance id (skips the SSM `instance-id` lookup) |
| `--api-url <url>` | — | Direct DBLab API URL — no AWS/SSM at all; requires a configured token |
| `--config <path>` | — | Explicit path to `tendb.json` |
| `-o, --output <format>` | `table` | Output format: `table` or `json` |
| `--quiet` | off | Suppress progress output on stderr |

:::caution
Write global flags **after** the subcommand. `tendb branches create x --region eu-north-1` works; `tendb --region eu-north-1 branches create x` does not — the root program does not accept these options.
:::

### stdout vs. stderr

The CLI keeps stdout clean for results and sends all progress chatter to stderr:

- Results — connection URIs, tables, JSON — go to **stdout**.
- Progress lines (dimmed) and warnings go to **stderr**. `--quiet` silences progress but not warnings.
- `-o json` prints pretty-printed JSON to stdout.
- Passwords are masked in progress lines, but **result URIs on stdout contain the real password** — mask them in CI logs (see [`tendb ci`](#tendb-ci)).

### Branch names

Every command that takes a branch name applies the same rules:

- A bare number `N` becomes `pr-N` (CI shorthand): `tendb branches create 42` creates `pr-42`.
- Names must match `[a-z0-9][a-z0-9-]*`, max 63 characters — lowercase alphanumerics and dashes, starting with an alphanumeric. Anything else exits 2 with `invalid branch name`.

The name does triple duty: it is the DBLab branch name, the clone id, and (with dashes turned into underscores) the Postgres role name inside the clone.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success (including `ci delete` of an absent branch or a down platform) |
| 1 | Generic/API error, unexpected errors |
| 2 | Usage error (bad name, bad flag value, missing token in direct mode, …) |
| 3 | Branch/clone not found |
| 4 | Timeout, or a clone entered a FATAL state |
| 5 | Missing dependency (`session-manager-plugin` or `psql` not on `PATH`) |
| 10 | Platform down (the SSM `instance-id` or token parameter is missing) |
| 42 | Clone capacity exhausted (port pool full) |

Errors print as `error: <message>` plus an optional `hint:` line on stderr. `psql`, `tunnel`, and `migrate` propagate the child process's exit code.

:::note
Commander's own parse errors (unknown command, missing required argument) exit with code 1, not 2. Code 2 applies to usage errors raised by tendb itself.
:::

## tendb branches

Manage branch databases — DBLab branches plus their copy-on-write clones.

### tendb branches create

```bash
tendb branches create <name> [--from <branch>] [--fresh]
```

| Flag | Default | Meaning |
|---|---|---|
| `--from <branch>` | `main` | Base branch — honored only when the branch does not already exist |
| `--fresh` | off | Snapshot the streaming sync target first, so the branch is "main as of now" rather than "as of the last snapshot" |

Creation is **idempotent**: an existing healthy clone is reused as-is; a wedged clone (any state other than `OK`) is deleted and recreated. The command waits for the first pool snapshot to exist (up to `snapshotTimeoutSeconds`, default 900 s), creates the DBLab branch if absent, creates the clone, and waits for it to reach `OK` (up to `cloneTimeoutSeconds`, default 120 s).

```bash
tendb branches create my-feature
tendb branches create 42                       # creates pr-42
tendb branches create rehearse --from staging --fresh
```

Output: table mode prints `branch <name> ready` on stderr and the connection URI as the only stdout line. JSON mode prints `{ name, state, port, uri }`.

Exit codes: 0 success; 2 bad name; 4 snapshot timeout or clone failure; 42 capacity exhausted; 10 platform down.

:::caution
`--from` is ignored when the branch already exists — the existing branch (and its base) wins.
:::

### tendb branches list

```bash
tendb branches list
```

Fetches branches and clone status in parallel and joins them. The table shows `BRANCH  STATE  PORT  DATA STATE AT  AGE` and excludes `main`; a `N clone(s) running` summary goes to stderr.

JSON mode prints `{ branches, clones }` with the raw engine objects — **including `main`**, unlike the table.

### tendb branches get

```bash
tendb branches get <name>
```

Looks up the branch's clone. Table mode prints a one-row table plus the connection URI on stdout; JSON mode prints `{ name, state, port, createdAt, uri }`. Exits 3 if the clone does not exist.

### tendb branches delete

```bash
tendb branches delete <name>
```

Deletes the clone (tolerating "already gone"), polls up to 60 s for it to disappear, then deletes the branch. Exits 0 even when the branch never existed; exits 4 if the clone is still present after deletion. Table mode prints nothing on stdout; JSON mode prints `{ name, deleted: true }`.

### tendb branches reset

```bash
tendb branches reset <name>
```

Deletes and recreates the clone on its **existing** branch — a fresh copy-on-write from the branch snapshot, discarding all changes made on the branch. Exits 3 if the branch has no clone.

Output: `branch <name> reset` on stderr and the URI on stdout; JSON mode prints `{ name, state, port, uri }`.

## tendb psql

```bash
tendb psql <name> [-- <psqlArgs...>]
```

Opens an SSM port-forward to the branch's Postgres port (on a random local port) and launches `psql` connected to it, fully interactive. Extra arguments after `--` are passed through to psql — they are placed before the connection string, because psql ignores trailing options.

```bash
tendb psql pr-42
tendb psql pr-42 -- -c 'select count(*) from users'
```

The CLI exits with psql's exit code. If `psql` is missing from `PATH`, it exits 5 with an install hint (`brew install libpq` or `postgresql`). Not available in [direct `--api-url` mode](/reference/configuration/#direct-mode---api-url) (exits 2 — port forwarding needs SSM).

## tendb connection-string

```bash
tendb connection-string <name> [--local]
```

Prints the branch's connection URI — and nothing else — on stdout, neonctl-style. It opens no tunnel itself. `-o json` has no effect on this command.

| Flag | Meaning |
|---|---|
| `--local` | Rewrite the host to `127.0.0.1` and the port to the clone's remote port, for use through an already-open `tendb tunnel <name>` |

```bash
tendb connection-string pr-42
tendb connection-string pr-42 --local   # pair with: tendb tunnel pr-42
```

:::caution
`--local` assumes your tunnel's local port equals the clone's remote port (the `tendb tunnel` default). If you opened the tunnel with `--port`, the printed URI will point at the wrong port.
:::

## tendb tunnel

```bash
tendb tunnel [name] [--port <port>] [-- <cmd...>]
```

| Argument / flag | Default | Meaning |
|---|---|---|
| `[name]` | — | Branch to forward; **omit it to forward the DBLab API port (2345)** instead |
| `--port <port>` | same as the remote port | Local port |
| `[cmd...]` | — | Command to run with `DATABASE_URL` exported (write it after `--`) |

**Foreground mode** (no command): prints `forwarding localhost:<local> → <remote> (ctrl-c to stop)` and, when a branch was named, a ready-to-copy `DATABASE_URL=...` line — both on stderr. Blocks until Ctrl-C (exit 0). If the SSM session dies on its own (session duration limits), the command exits **1** so scripts notice — respawning is your job.

**Exec mode** (command after `--`): opens the tunnel, runs the command with `DATABASE_URL` set to the tunnel-localized URI and `stdio` inherited, then exits with the command's exit code.

```bash
tendb tunnel pr-42                  # forward pr-42's Postgres port
tendb tunnel pr-42 --port 5433      # pick the local port
tendb tunnel pr-42 -- npm test      # run tests against the branch
tendb tunnel                        # DBLab API on localhost:2345
```

:::caution
In exec mode without a branch name, the command runs against the API tunnel with **no** `DATABASE_URL` set.
:::

## tendb status

```bash
tendb status
```

Checks engine health, fetches `/status`, and reads clone capacity from the SSM port-pool parameter — all in parallel. The table shows:

| Row | Content |
|---|---|
| `health` | `ok` or `UNREACHABLE` |
| `engine` | DBLab Engine version |
| `transport` | `ssm (i-…)` or `direct` |
| `sync mode` / `sync status` | Retrieval mode and state |
| `last refresh` / `next refresh` | Refresh timestamps |
| `data state at` | Data-state timestamp of the first pool |
| `disk` | `X.XG used / Y.YG (Z.ZG free)` |
| `clones` | `n / cap` when the port-pool parameter exists, else bare `n` |

Running clone ids are listed on stderr. JSON mode prints `{ healthy, transport, instanceId, engineVersion, retrieving, pools, clonesUsed, cloneCapacity }` (`cloneCapacity` is `null` when unknown).

## tendb migrate

```bash
tendb migrate [branch] [--scratch] [--from <branch>] [--keep] [--fresh] -- <cmd...>
```

Runs a migration command with `DATABASE_URL` pointed at a branch, then exits with the command's exit code. This is the migration face of the CI contract.

| Flag | Default | Meaning |
|---|---|---|
| `--scratch` | off | Create an ephemeral branch (`migrate-<timestamp>`), run, then delete it — even on failure, so reruns start pristine |
| `--from <branch>` | `main` | Base branch for `--scratch` |
| `--keep` | off | Keep the scratch branch after the run |
| `--fresh` | off | Snapshot the streaming sync target first — rehearse on data as of now |

Name a branch, or pass `--scratch` for an ephemeral one; either way, the command comes after `--`. Omitting both the branch and `--scratch`, or omitting the command, exits 2 with a usage error.

```bash
tendb migrate my-branch -- npx prisma migrate deploy
tendb migrate --scratch -- npx prisma migrate deploy      # rehearse + clean up
tendb migrate --scratch --keep --fresh -- ./migrate.sh    # rehearse on fresh data, keep the evidence
```

Under SSM transport the branch URL is tunneled per call; in direct mode the clone URI is dialed as-is (assumes in-VPC reachability).

Output: table mode prints one stderr line — `ok on <branch> in <ms>ms` or `failed (exit N) on <branch> in <ms>ms`, plus `— scratch branch removed` when applicable. JSON mode prints `{ ok, exitCode, durationMs, branch, kept }` on stdout.

## tendb ci

Script-friendly verbs with a strict machine contract, designed as a drop-in for branch-per-PR shell scripts (see [CI previews](/guides/ci-previews/)):

- The connection URI is the **last line on stdout**; everything else goes to stderr.
- A bare number `N` means branch `pr-N`.

### tendb ci ensure

```bash
tendb ci ensure <id>
```

Ensures the branch and clone exist and are ready (same idempotent semantics as `branches create`, without `--from`/`--fresh`), then prints the URI on stdout. Exit codes: 0, 42 (capacity), 4 (timeout/FATAL), 10 (platform down), 1.

### tendb ci url

```bash
tendb ci url <id>
```

Prints the URI of an **existing** branch database. Exits 3 when it does not exist.

### tendb ci delete

```bash
tendb ci delete <id>
```

Deletes the branch database. Exits **0** both when the branch is already gone and when the platform is down (`DBLab host absent — nothing to delete` on stderr) — so PR-close cleanup jobs never fail spuriously. Other errors still propagate.

Mask the URI in GitHub Actions logs:

```bash
URI=$(tendb ci ensure "$PR_NUMBER" | tail -1)
echo "::add-mask::$URI"
```

## tendb checkup

```bash
tendb checkup [--strict]
```

Runs the full health rule set: engine health, disk usage, clone capacity, data staleness (measured from the newest pool snapshot in streaming mode), logical replication health on both publisher and subscriber, and schema drift. Cron-able — see [operations](/guides/operations/).

| Flag | Meaning |
|---|---|
| `--strict` | Exit non-zero on warnings as well as criticals |

Finding codes: `engine-unreachable`, `sync-alerts`, `data-stale`, `disk-usage`, `clone-capacity`, `replication-publisher`, `replication-subscriber`, `subscription-disabled`, `replication-errors`, `slot-inactive`, `replication-lag`, `replication-stale`, `schema-drift`. Disk and capacity findings escalate from warning to critical; replication connectivity findings are critical.

Default thresholds:

| Threshold | Default |
|---|---|
| `dataStaleHours` | 26 — drops automatically to **2** when streaming replication is configured (unless explicitly overridden) |
| `diskWarnRatio` / `diskCriticalRatio` | 0.8 / 0.92 |
| `capacityWarnRatio` | 0.8 |
| `replicationLagBytes` | 52428800 (50 MiB) |
| `replicationStaleSeconds` | 300 |

Output: `health  ok — no findings`, or a `severity code message` table. JSON mode prints `{ ok, findings, measuredAt }`. Exit: 1 if any critical finding (or, with `--strict`, any finding at all); else 0.

## tendb snapshots

Pool snapshots for streaming deployments. The engine host runs `tendb-snapshotd`, which CHECKPOINTs the sync target and takes an O(1) ZFS snapshot — seconds at any database size. The CLI drives it through two SSM parameters: `<prefix>/snapshots/config` (the schedule) and `<prefix>/snapshots/request` (a nonce meaning "snapshot now"). See [data refresh](/concepts/data-refresh/).

:::note
The `snapshots` and `schema` commands read and write SSM parameters, so they need AWS access even in direct `--api-url` mode — configure `region` (and credentials) there, or you get `snapshot control needs AWS access` (exit 2).
:::

### tendb snapshots list

```bash
tendb snapshots list
```

Lists pool snapshots, newest first (branch-head snapshots are excluded). Table: `ID  DATA STATE AT`. JSON mode prints the raw snapshot array.

### tendb snapshots create

```bash
tendb snapshots create
```

Requests a snapshot now and polls until a new pool snapshot appears (default timeout 90 s; on timeout, exit 4 with the hint to check `systemctl status tendb-snapshotd` on the engine host). Table mode prints `snapshot <id> ready in X.Xs` on stderr and the snapshot id on stdout; JSON mode prints the snapshot plus `durationMs`.

### tendb snapshots config

```bash
tendb snapshots config [--interval-minutes <n>] [--retain <n>]
```

| Flag | Constraint | Meaning |
|---|---|---|
| `--interval-minutes <n>` | 0–10080 | Minutes between scheduled snapshots; `0` = manual only |
| `--retain <n>` | 1–500 | Pool snapshots to keep (in-use ones are never pruned) |

With no flags, shows the current schedule (defaulting to `{intervalMinutes: 0, retain: 24}` when the parameter is absent). With any flag, merges with the current config and writes it — the on-host executor picks it up within seconds.

```bash
tendb snapshots config --interval-minutes 60 --retain 24
```

## tendb schema

DDL never travels over logical replication, so the sync target's schema drifts silently when you migrate the source. These commands surface and reconcile that drift, driven by SSM parameters `<prefix>/schema/config` and `<prefix>/schema/sync-request`. The same AWS-access requirement as [`snapshots`](#tendb-snapshots) applies.

### tendb schema diff

```bash
tendb schema diff
```

Fingerprints every `public` table on the publisher and the subscriber (an md5 over each table's ordered column/type/nullability list) and reports three buckets:

- **missing on sync target** — tables that exist only on the publisher; the first replicated write to one of these pauses the stream
- **only on sync target** — orphaned tables that will collide if recreated upstream
- **columns differ** — tables whose column definitions diverge

Prints `schema  in sync` when clean; JSON mode prints `{ missing, orphaned, mismatched, inSync }`. **Exits 1 when drifted, 0 when in sync** — usable as a CI gate. Exits 2 with `cannot compare schemas` when either side did not answer.

### tendb schema sync

```bash
tendb schema sync
```

**Destructive full reconcile** via the engine-host daemon: missing tables are created, **orphaned tables are dropped**, mismatched tables are rebuilt, the publication is refreshed, and error counters are reset. The CLI writes a sync-request nonce and polls the drift check every 3 s until clean (default timeout 120 s; on timeout, exit 4 with a hint to check `journalctl -u tendb-snapshotd` on the engine host).

:::danger
`schema sync` drops tables that exist only on the sync target. It reconciles the sync target to the source — by design.
:::

Output: a single stderr progress line, `schema in sync (X.Xs)`. This subcommand prints nothing on stdout, even with `-o json`.

### tendb schema config

```bash
tendb schema config [--auto-sync <on|off>]
```

Shows or sets auto-heal: with it on, the engine-host daemon fixes *additive* drift (new tables) on its own at roughly one-minute cadence. With no flag, shows the current setting (default `off`). Table output: `auto-heal  on|off`; JSON: `{ autoSync }`.

## tendb console

```bash
tendb console [--port <port>] [--no-open]
```

| Flag | Default | Meaning |
|---|---|---|
| `--port <port>` | `4400` | Local port |
| `--no-open` | opens | Do not open a browser |

Starts the tendb web console — a Neon-style dashboard served locally, bound to **127.0.0.1 only**. The server proxies the DBLab API, injects the verification token server-side, runs SQL against clones through on-demand tunnels, and runs a 60 s alert loop with optional Slack notifications (webhook stored in SSM at `<prefix>/alerts/slack-webhook`). The token and your AWS credentials never reach the browser. With a streaming sync target configured, branch `main` is served live and read-only from the sync target.

Prints `tendb console: http://localhost:<port>` on stderr and blocks until Ctrl-C. See the [console guide](/guides/console/) for what's inside.

## tendb ui

```bash
tendb ui [--no-open]
```

Opens the DBLab Engine's own embedded UI through two fixed-port tunnels: UI on `localhost:2346` and API on `localhost:2345` (the UI's browser code calls `localhost:2345`, so local ports must match the remote ones exactly). Blocks until Ctrl-C. SSM transport only — in direct mode it exits 2, because the embedded UI is bound to the host's loopback.

| Flag | Meaning |
|---|---|
| `--no-open` | Do not open a browser (a failed auto-open prints the URL instead) |

The verification token you need to paste into the UI's auth field is printed on **stdout**.

:::caution
The verification token lands on stdout — be careful with shell logging and pipes.
:::

## Common errors

| Message | Exit | What to do |
|---|---|---|
| `DBLab host not found (/tendb/instance-id missing — platform down?)` | 10 | Bring the platform up (`terraform apply`) |
| `session-manager-plugin not found on PATH` | 5 | Install the AWS Session Manager plugin (the hint shows brew/dpkg commands) |
| `psql not found on PATH` | 5 | `brew install libpq` (or `postgresql`) |
| `cannot reach DBLab API at <url>` | 1 | Is the tunnel/engine up? Try `tendb status` |
| `clone <name> not found` | 3 | The branch has no clone — create it |
| `clone capacity exhausted` | 42 | Delete an idle branch (`tendb branches list`) or grow the terraform `clone_port_range` (see the [engine module](/reference/terraform-engine/)) |
| `no snapshot after 15m` | 4 | Check `docker logs dblab_server` and `/var/log/dblab-init.log` on the host |
| `direct mode (--api-url) needs a token` | 2 | Set `token` in `tendb.json` or `TENDB_TOKEN` |
| `no new snapshot after 90s` | 4 | Check `systemctl status tendb-snapshotd` on the engine host |

AWS SDK credential errors (expired SSO, missing `ssm:StartSession` permission) are not wrapped — they surface as `unexpected error: <stack>` with exit 1.
