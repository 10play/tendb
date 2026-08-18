<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/10play/tendb/main/apps/docs/src/assets/brand/tendb-lockup-dark.png">
    <img src="https://raw.githubusercontent.com/10play/tendb/main/apps/docs/src/assets/brand/tendb-lockup-light.png" alt="tendb" width="170">
  </picture>
</div>

# @10play/tendb

Neon-style Postgres branching on infrastructure you own. Copy-on-write
branches of your real database — AWS, GCP, Azure, or your laptop's Docker —
ready in seconds, powered by [DBLab Engine](https://postgres.ai) (Postgres.ai).

[Documentation](https://10play.github.io/tendb/) · [Quickstart](https://10play.github.io/tendb/getting-started/quickstart/) · [Example app](https://github.com/10play/tendb/tree/main/apps/example)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/10play/tendb/main/apps/docs/src/assets/console/dashboard-dark.png">
  <img src="https://raw.githubusercontent.com/10play/tendb/main/apps/docs/src/assets/console/dashboard-light.png" alt="The tendb console: branches, storage, sync state, and platform settings on one dashboard" width="820">
</picture>

*The bundled console (`tendb console`) — branches, SQL editor, snapshots, and
alerts on localhost. Nothing sensitive ever reaches the browser.*

## Get the infra up (from zero)

Prereqs: Node ≥ 20, Terraform ≥ 1.11, and (for the `local` platform) Docker.
`local` needs no cloud account — on macOS the preflight builds a small colima
VM (Homebrew required; Docker Desktop's kernel has no ZFS); Linux runs it
natively.

```sh
npm install -g @10play/tendb

tendb init --platform local   # scaffold terraform + tendb.json into your project
tendb up                      # preflight + terraform apply + wire tendb.json
tendb branches create my-feature
```

`init` prompts for a platform (`aws` · `gcp` · `azure` · `local`) and its few
required inputs, then writes a `tendb/` Terraform directory you own (module
sources pinned to a tendb release) and a `tendb.json`. `tendb up` wraps
`terraform init && apply` and folds the stack's discovery outputs back into
`tendb.json`; `tendb down` destroys the stack. On `local`, `up` also
provisions the ZFS Docker host and a seeded demo source to branch from.

## Daily commands

| Command | What it does |
|---|---|
| `tendb branches create <name>` | idempotent create-or-reuse; prints the connection URI |
| `tendb psql <name> [-- args]` | auto tunnel + psql |
| `tendb status` | engine health, sync state, disk, clone capacity |
| `tendb console` | the dashboard shown above, on localhost |
| `tendb migrate <branch> -- <cmd>` | run `cmd` with `DATABASE_URL` on the branch |
| `tendb ci ensure <id>` | a preview database per pull request (contract below) |

A bare number is PR shorthand everywhere: `tendb ci ensure 42` → branch `pr-42`.
The [full command reference](https://10play.github.io/tendb/reference/cli/)
covers the rest — `tunnel`, `connection-string`, `snapshots`, `schema`,
`checkup`, `ui`, `down` — plus every flag and exit code.

Global flags: `--env`, `--platform`, `--region`, `--profile`, `--ssm-prefix`,
`--instance-id`, `--api-url`, `--config`, `-o/--output table|json`, `--quiet`.

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
| 5 | missing local dependency (session-manager-plugin, terraform, psql) |
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

`tendb console` opens the platform's native tunnel (SSM on AWS, IAP on GCP,
Bastion on Azure, loopback locally), serves the bundled SPA + a local API on
`127.0.0.1:<port>` (default 4400), and opens the browser. Screens: branches
(create/delete/reset + connection details), SQL editor (queries run server-side
through per-clone tunnels), snapshots & sync. The verification token and your
cloud credentials never reach the browser.

## Development

```bash
pnpm install
pnpm test            # vitest: unit + built-binary contract tests vs a mock engine
pnpm build           # tsup (CLI → dist/index.js) + vite (console → dist/console/)
```

Working on the CLI or console itself? See the
[repository](https://github.com/10play/tendb) for the dev loop and transport
internals.
