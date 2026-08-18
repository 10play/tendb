# @10play/tendb

Neon-style CLI + local console for a [tendb](../README.md) engine (DBLab on
AWS, reached over SSM Session Manager).

## Commands

| Command | What it does |
|---|---|
| `tendb branches create <name> [--from main]` | idempotent create-or-reuse; prints the connection URI |
| `tendb branches list \| get \| delete \| reset <name>` | branch lifecycle (`reset` recreates the clone from its branch snapshot) |
| `tendb connection-string <name> [--local]` | URI only on stdout; `--local` rewrites to 127.0.0.1 for tunnel use |
| `tendb status` | engine health, sync state, disk, clones used / capacity |
| `tendb psql <name> [-- args]` | auto tunnel + psql |
| `tendb tunnel [<name>] [--port N] [-- cmd]` | port-forward a clone (or the API); exec form runs `cmd` with `DATABASE_URL` set |
| `tendb ui` | DBLab's embedded engine UI (tunnels 2345+2346, prints the token) |
| `tendb console` | **the tendb console** — Neon-style dashboard on localhost |
| `tendb ci ensure \| url \| delete <id>` | machine contract (below) |
| `tendb migrate <branch> -- <cmd>` | run `cmd` with `DATABASE_URL` on the branch; `--scratch` rehearses on an ephemeral branch and cleans up |
| `tendb checkup [--strict]` | health findings (engine, sync, disk, capacity, replication); exit 1 on critical — cron-able |
| `tendb snapshots list \| create \| config` | pool snapshots: take one on demand (O(1) `zfs snapshot`, ~10s wall at any DB size), read/update the schedule the engine host follows |

`branches create --fresh` and `migrate --fresh` snapshot the streaming sync
target first — the branch is *main as of now*, not as of the last snapshot.

Global flags: `--env`, `--region`, `--profile`, `--ssm-prefix`, `--instance-id`,
`--api-url`, `--config`, `-o/--output table|json`, `--quiet`.

A bare number is PR shorthand everywhere: `tendb ci ensure 42` → branch `pr-42`.

## The CI contract (`tendb ci …`)

Drop-in for the legacy `dblab-branch.sh` / `neon-branch.sh`:

- the connection URI is the **last line on stdout**; all progress goes to stderr
- `ci delete` exits **0** when the branch is already gone or the platform is
  down (SSM `instance-id` param missing)
- mask the URI in CI logs: `URI=$(tendb ci ensure "$PR" | tail -1)` then
  `echo "::add-mask::$URI"`

### Exit codes

| code | meaning |
|---|---|
| 0 | success (incl. delete-of-absent) |
| 1 | generic/API error |
| 2 | usage error |
| 3 | branch/clone not found |
| 4 | timeout or clone FATAL |
| 5 | missing local dependency (session-manager-plugin, psql) |
| 10 | platform down |
| 42 | clone capacity exhausted (port pool full) |

## SDK

The same internals, importable — `import { createClient } from "@10play/tendb"`.
Config resolution matches the CLI (flags-shaped options > `TENDB_*` env >
`tendb.json` > defaults); the session opens lazily and `close()` tears
tunnels down.

```ts
import { createClient, webhookSink } from "@10play/tendb";

const client = createClient(); // tendb.json discovery, or pass { ssmPrefix, region, ... }

// Branch lifecycle
const branch = await client.branches.create("my-feature", { from: "main" });
await client.branches.reset("my-feature");
await client.branches.delete("my-feature");

// Migration rehearsal on production-shaped data (scratch branch, auto-cleanup)
const result = await client.migrate({ command: ["npx", "prisma", "migrate", "deploy"] });
if (!result.ok) process.exit(result.exitCode);

// Ephemeral branch for tests
await client.withBranch("it-tests", async ({ url }) => {
  // url is dial-ready (SSM branches get a tunnel automatically)
});

// Monitoring: one-shot findings, or a poller with pluggable sinks
const { ok, findings } = await client.checkup();
const watcher = client.watch({
  intervalMs: 60_000,
  ...webhookSink("https://hooks.example.com/tendb"), // or your own onAlert/onRecover
});
// later: watcher.stop(); await client.close();
```

`checkup()`/`watch()` evaluate typed findings — `engine-unreachable`,
`data-stale`, `disk-usage`, `clone-capacity`, `replication-lag`,
`subscription-disabled`, … — with overridable thresholds. `watch()` emits
transitions only (alert on appear/escalate, recover on clear), so wiring
Slack/PagerDuty later is a matter of swapping the callback.

## Configuration

Precedence: flags > `TENDB_*` env vars > `tendb.json` (found upward from
cwd) > defaults.

```jsonc
// tendb.json
{
  "ssmPrefix": "/tendb",        // where the terraform module put its params
  "region": "eu-north-1",
  "profile": null,                 // AWS profile (SDK default chain otherwise)
  "instanceId": null,              // set to skip SSM discovery
  "apiUrl": null,                  // DIRECT MODE: http://…:2345 — no AWS at all
  "token": null,                   // direct-mode token (prefer TENDB_TOKEN)
  "database": null,                // default: SSM <prefix>/dbname (host-published)
  "snapshotTimeoutSeconds": 900,
  "cloneTimeoutSeconds": 120,
  "environments": {                // select with --env / TENDB_ENV
    "staging": { "ssmPrefix": "/staging" }
  }
}
```

Env vars: `TENDB_ENV`, `TENDB_SSM_PREFIX`, `TENDB_REGION`,
`TENDB_PROFILE`, `TENDB_INSTANCE_ID`, `TENDB_API_URL`,
`TENDB_TOKEN`, `TENDB_DATABASE`, `TENDB_CONFIG`.

## The console

`tendb console` opens an SSM tunnel, serves the bundled SPA + a local API on
`127.0.0.1:<port>` (default 4400), and opens the browser. Screens: branches
(create/delete/reset + connection details), SQL editor (queries run server-side
through per-clone tunnels), snapshots & sync. The verification token and AWS
credentials never reach the browser.

## Development

```bash
pnpm install
pnpm test            # vitest: unit + built-binary contract tests vs a mock engine
pnpm build           # tsup (CLI → dist/index.js) + vite (console → dist/console/)
```

Console dev loop: `node dist/index.js console --no-open --port 4400` in one
terminal, `pnpm exec vite dev console` in another (the vite dev server proxies
`/api` to :4400).

Transport note: the CLI spawns `session-manager-plugin` with the same six-arg
invocation the aws CLI uses (StartSession response JSON, region, `StartSession`,
profile, request params JSON, SSM endpoint). That contract is de-facto, not
documented — if a plugin release breaks it, `src/aws/session.ts` is the only
place to fix.
