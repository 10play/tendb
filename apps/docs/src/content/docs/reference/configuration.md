---
title: Configuration reference
description: tendb.json fields and discovery, environment variables, AWS credential resolution, direct API mode, and the programmatic SDK.
---

Every `tendb` command resolves its configuration from four layers. Higher layers win:

1. **Command-line flags** (`--region`, `--ssm-prefix`, …)
2. **`TENDB_*` environment variables**
3. **`tendb.json`** — an environment block selected with `--env` wins over the file's top level
4. **Defaults** — `platform: aws`, `ssmPrefix: /tendb`, `snapshotTimeoutSeconds: 900`, `cloneTimeoutSeconds: 120`

## tendb.json

### Discovery

The CLI searches for `tendb.json` starting in the current directory and walking **upward to the filesystem root**; the first file found wins. Commit one at your repo root and every command run anywhere in the repo picks it up. Override the search with `--config <path>` or `TENDB_CONFIG`.

The file is validated strictly: an **unknown key — including a typo — fails the whole config load** with `invalid config in <path>` (exit 2). Unreadable files and invalid JSON also exit 2.

### Fields

All fields are optional:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `platform` | `"aws" \| "gcp" \| "azure" \| "local"` | `aws` | Which [platform adapter](/concepts/platforms/) to use; `apiUrl` overrides it (direct mode) |
| `paramPrefix` | string, must start with `/` | `/tendb` | The engine-contract namespace — the platform-neutral name for `ssmPrefix`; either works, `paramPrefix` wins within a layer |
| `ssmPrefix` | string, must start with `/` | `/tendb` | Where the terraform module published its SSM parameters |
| `region` | string | AWS SDK default chain | AWS region |
| `profile` | string | — | AWS profile, loaded from the shared credentials file |
| `instanceId` | string | — | Engine host EC2 instance id; skips the SSM `instance-id` lookup |
| `apiUrl` | URL string | — | Direct DBLab API URL — enables [direct mode](#direct-mode---api-url) |
| `token` | string | — | DBLab verification token. Required in direct mode (prefer `TENDB_TOKEN` over committing it); on SSM transport it skips the SSM token lookup |
| `database` | string | SSM `<prefix>/dbname` | Database name inside clones |
| `snapshotTimeoutSeconds` | positive integer | `900` | How long to wait for the first pool snapshot |
| `cloneTimeoutSeconds` | positive integer | `120` | How long to wait for a clone to reach `OK` |
| `replicationPublisherUrl` | string | SSM `<prefix>/replication/publisher-url` | Upstream replication endpoint, for the sync view and `checkup` |
| `replicationSubscriberUrl` | string | SSM `<prefix>/replication/subscriber-url` | Sync-target endpoint, same consumers |
| `platform` | `"aws"` \| `"gcp"` \| `"azure"` \| `"local"` | `aws` | Platform adapter for the session. `aws` (the SSM transport documented on this page) is the default; the others swap in the matching secret/param store and tunnel transport |
| `paramPrefix` | string, must start with `/` | — | Platform-neutral alias of `ssmPrefix` (the engine contract's canonical name). When both appear in the same precedence layer, `paramPrefix` wins |
| `gcpProject` | string | the gcloud CLI's project | `gcp` platform only: Secret Manager project holding the engine-contract params |
| `azureVault` | string | — | `azure` platform only: Key Vault name holding the engine-contract params |
| `stateDir` | string | `~/.tendb/local` | `local` platform only: state directory containing `params.json` |
| `deployDir` | string | `tendb` | Terraform deployment dir written by [`tendb init`](/reference/cli/#tendb-init), relative to this file (top level only); `tendb up`/`down` run there |
| `environments` | object of the above | — | Named environment blocks (top level only); select with `--env` / `TENDB_ENV` |

### Environments

`environments` maps names to blocks of the same fields. A selected block overrides the top level, field by field:

```json
{
  "region": "eu-north-1",
  "environments": {
    "prod": { "ssmPrefix": "/tendb/prod" },
    "staging": { "ssmPrefix": "/tendb/staging", "profile": "staging-admin" }
  }
}
```

```bash
tendb status --env staging
```

Selecting an environment that does not exist in the file exits 2 with `environment "<name>" not found`.

## Environment variables

| Variable | Maps to |
|---|---|
| `TENDB_ENV` | `--env` |
| `TENDB_PLATFORM` | `platform` |
| `TENDB_SSM_PREFIX` | `ssmPrefix` |
| `TENDB_PARAM_PREFIX` | `paramPrefix` |
| `TENDB_REGION` | `region` — falls back to `AWS_REGION` when unset |
| `TENDB_PROFILE` | `profile` |
| `TENDB_INSTANCE_ID` | `instanceId` |
| `TENDB_API_URL` | `apiUrl` |
| `TENDB_TOKEN` | `token` |
| `TENDB_DATABASE` | `database` |
| `TENDB_SNAPSHOT_TIMEOUT` | `snapshotTimeoutSeconds` |
| `TENDB_CLONE_TIMEOUT` | `cloneTimeoutSeconds` |
| `TENDB_REPLICATION_PUBLISHER_URL` | `replicationPublisherUrl` |
| `TENDB_REPLICATION_SUBSCRIBER_URL` | `replicationSubscriberUrl` |
| `TENDB_GCP_PROJECT` | `gcpProject` |
| `TENDB_AZURE_VAULT` | `azureVault` |
| `TENDB_STATE_DIR` | `stateDir` |
| `TENDB_CONFIG` | `--config` (explicit path to `tendb.json`) |

`TENDB_STATE_DIR` does double duty: on the local platform it locates `params.json`, and when set for `tendb console` (the hosted service sets it) the console persists its alert feed and seen-findings map to `<dir>/alerts.json` so a restart doesn't replay Slack alerts.

:::caution
Two things to watch:

- `AWS_REGION` sits at the environment-variable tier, so it **overrides `region` in `tendb.json`**. If commands hit the wrong region, check your shell.
- The timeout variables are converted with `Number()` without validation — `TENDB_CLONE_TIMEOUT=abc` silently yields `NaN` timeouts. Note the env names lack the `_SECONDS` suffix the JSON fields carry.
:::

## AWS credentials and region

The SSM API is the **only** AWS surface the CLI touches — four operations: `GetParameter`, `PutParameter`, `StartSession`, `TerminateSession`. Resolution is standard AWS SDK behavior:

- With `--profile` (or the `profile` field), credentials load from your shared AWS config/credentials files for that profile.
- Otherwise the **SDK default chain** applies: environment variables, shared config (including `AWS_PROFILE`), SSO sessions, instance metadata, and so on.
- `region` is set on the client only when configured; otherwise the SDK's own region resolution applies. The effective region is read back off the client and reused for the `session-manager-plugin` invocation.

Port forwarding additionally requires the [AWS Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html) (`session-manager-plugin`) on your `PATH`; without it, commands that tunnel exit 5 with install instructions.

AWS SDK errors (expired SSO, missing `ssm:StartSession`) are not wrapped by the CLI — they surface as `unexpected error` with exit 1.

### The SSM discovery contract

The terraform [engine module](/reference/terraform-engine/) publishes everything the CLI needs under `${ssmPrefix}/`:

| Parameter | Purpose |
|---|---|
| `<prefix>/instance-id` | Engine host EC2 instance id. **Missing means platform down** — exit 10 |
| `<prefix>/verification-token` | DBLab API token (SecureString) |
| `<prefix>/dbname` | Default database name inside clones |
| `<prefix>/host` | Engine host address (used to detect a sync target running on the engine host) |
| `<prefix>/port-pool` | Clone port range, e.g. `"6000-6009"` → capacity 10 |
| `<prefix>/snapshots/config`, `<prefix>/snapshots/request` | Snapshot schedule / snapshot-now nonce |
| `<prefix>/schema/config`, `<prefix>/schema/sync-request` | Schema auto-heal config / full-sync nonce |
| `<prefix>/replication/publisher-url`, `<prefix>/replication/subscriber-url` | Replication endpoints (SecureString) |
| `<prefix>/alerts/slack-webhook` | Console Slack webhook (SecureString; `"none"` = cleared) |
| `<prefix>/console-url` | "Open console" link used in Slack messages (`"none"` = unset) |

`--instance-id` (or the `instanceId` field) skips only the instance-id lookup; the token is still fetched from SSM unless `token` is configured too.

## Direct mode (--api-url)

When `apiUrl` is set — flag, `TENDB_API_URL`, or `tendb.json` — the CLI talks to the DBLab API directly and makes **no AWS calls at all**. This is how you point tendb at a local or in-VPC development engine:

```bash
tendb branches create try-this \
  --api-url http://localhost:2345
```

```json
{
  "apiUrl": "http://localhost:2345",
  "database": "app"
}
```

```bash
export TENDB_TOKEN=your-verification-token
```

Direct mode requires:

- **`token`** — there is no SSM to fetch it from. Missing → `direct mode (--api-url) needs a token`, exit 2.
- **`database`** — needed to build connection URIs. Missing → `database name unknown`, exit 1.

What changes in direct mode:

- **No port forwarding.** `psql`, `tunnel`, and `ui` exit 2. `migrate` and SDK `exec` dial the clone URI as-is, which assumes you can reach the engine host's network (local engine, or you're inside the VPC).
- **`snapshots` and `schema` still need a reachable param store** — they work through the engine-contract namespace. On `aws` that means `region` (plus credentials), or those commands exit 2 with `snapshot control needs AWS access`; on `gcp`/`azure`/`local` it means `gcpProject` / `azureVault` / `stateDir` respectively.

## Global flags

Every leaf command accepts the shared flag set (`--env`, `--platform`, `--region`, `--profile`, `--ssm-prefix`, `--instance-id`, `--api-url`, `--config`, `-o/--output`, `--quiet`). Flags sit at the top of the precedence order, above environment variables and `tendb.json`. Write them **after** the subcommand — see the [CLI reference](/reference/cli/#global-flags) for the full table and the reasoning.

## Programmatic use

The package's main export is a typed SDK — the same config resolution, transport, and workflows the CLI uses:

```ts
import { createClient, slackSink } from "@10play/tendb";
```

`createClient(options?)` accepts every config field above (as camelCase options, behaving like flags) plus `environment` (named env block), `configPath`, and `cwd`. The session opens lazily on first use; call `close()` to tear down tunnels.

```ts
import { createClient } from "@10play/tendb";

const tendb = createClient({ region: "eu-north-1" });

// Create (or reuse) a branch and run a command against it, then clean up.
const result = await tendb.migrate({
  command: ["npx", "prisma", "migrate", "deploy"],
  branch: "pr-42",
  fresh: true, // snapshot the sync target first
});
console.log(result.ok, result.durationMs);

// Or manage the lifecycle yourself:
const branch = await tendb.branches.create("load-test", { from: "main" });
console.log(branch.uri);
await tendb.branches.delete("load-test");

await tendb.close();
```

The `TenDBClient` surface:

| Area | Methods |
|---|---|
| Branches | `branches.list()`, `branches.create(name, {from?, fresh?})`, `branches.get(name)`, `branches.reset(name)`, `branches.delete(name)` |
| Connections | `connectionString(branch)` (canonical URI), `branchUrl(branch)` (dial-ready, tunneled over SSM — call its `close()`), `exec(branch, argv, env?)` |
| Workflows | `withBranch(name, fn, {from?, keep?})` (ensure → run → delete), `migrate(opts)` |
| Snapshots | `snapshots.list()`, `snapshots.create({timeoutMs?})`, `snapshots.getConfig()`, `snapshots.setConfig(config)` |
| Schema | `schema.diff()`, `schema.sync({timeoutMs?})` (destructive full reconcile), `schema.getConfig()`, `schema.setConfig({autoSync})` |
| Health | `status()`, `replication()`, `checkup(thresholds?)`, `watch(opts)` (polls checkup, emits transitions via `onAlert`/`onRecover`) |

`watch()` pairs with the exported sinks — `webhookSink(url)` POSTs alert/recover events as JSON, `slackSink(webhookUrl, {source?, consoleUrl?})` sends formatted Slack messages:

```ts
const watcher = tendb.watch({
  intervalMs: 60_000,
  ...slackSink(process.env.SLACK_WEBHOOK_URL!, { source: "prod" }),
});
// later: watcher.stop(); await tendb.close();
```

Also exported: the pure checkup helpers (`evaluateCheckup`, `DEFAULT_THRESHOLDS`, `debounceUnreachable`, `diffFindings`, `slackPayload`, `postToSlack`), the result types (`BranchHandle`, `BranchSummary`, `Checkup`, `Finding`, `MigrateResult`, `SchemaDiff`, `Snapshot`, and friends), and the error classes `TenDBError`, `NotFoundError`, `TimeoutError`, `UsageError`, `CapacityError`.

:::note
Two differences from the CLI:

- The SDK does **not** normalize branch names — `client.branches.create("42")` creates branch `42`, not `pr-42`.
- `PlatformDownError` and `MissingDependencyError` are not re-exported. Every tendb error carries a public `exitCode`, so test `err instanceof TenDBError && err.exitCode === 10` to treat "platform down" as benign, the way `tendb ci delete` does.
:::
