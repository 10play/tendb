---
title: Platforms
description: One engine contract, four places to run it — AWS, GCP, Azure, or Docker on your own machine.
---

tendb runs the same logical machine everywhere: a DBLab Engine host on ZFS,
discovered and controlled through a small key-value namespace, reached
through a platform-native tunnel. That shape is written down once — the
[engine contract](/reference/engine-contract/) — and each platform provides
three interchangeable pieces:

- **a param store** holding the contract namespace (discovery values,
  snapshot/schema control, alert settings),
- **a tunnel** that forwards the engine's ports to `127.0.0.1`,
- **a machine identity** the host uses to fetch its own secrets at boot.

Everything above that line — the CLI, the SDK, the console, `tendb-snapshotd`,
the clone-password derivation — is identical on every platform.

## The matrix

| | `aws` | `gcp` | `azure` | `local` |
|---|---|---|---|---|
| Host | EC2 + gp3/ZFS | Compute Engine + pd-ssd/ZFS | Linux VM + managed disk/ZFS | Docker containers on a ZFS VM |
| Param store | SSM Parameter Store (+ Secrets Manager) | Secret Manager | Key Vault | `~/.tendb/local/params.json` |
| Tunnel | SSM Session Manager | IAP TCP forwarding (`gcloud`) | Bastion Standard (`az`) | none — ports on loopback |
| Identity | instance profile | service account | managed identity | filesystem |
| Client tool | `session-manager-plugin` | `gcloud` | `az` | — |
| Status | **live** | validate-only | validate-only | **verified end-to-end** |

:::caution
`gcp` and `azure` ship syntax- and plan-validated but have never been
applied to a real account — expect first-apply friction. See
[GCP](/guides/gcp/) and [Azure](/guides/azure/) for the per-platform
caveats.
:::

## Selecting a platform

The CLI picks its adapter from the `platform` config field — `tendb.json`,
`TENDB_PLATFORM`, or `--platform`, in the usual
[precedence order](/reference/configuration/). The default is `aws`, and
existing AWS configs keep working unchanged.

```json
{
  "platform": "local",
  "stateDir": "/Users/you/.tendb/local"
}
```

Each platform brings one or two fields of its own: `region`/`profile` (aws),
`gcpProject` (gcp), `azureVault` (azure), `stateDir` (local). The parameter
namespace is `paramPrefix` (default `/tendb`; `ssmPrefix` remains as the
legacy alias).

`apiUrl` still means **direct mode**: talk to a DBLab API endpoint verbatim,
no platform adapter, no tunnels — unchanged from before, and it beats
`platform` when both are set.

`tendb status` reports which transport a session used: `ssm`, `iap`,
`bastion`, `local`, or `direct`.

## What "the same" means in practice

- `tendb branches create`, `psql`, `tunnel`, `ui`, `migrate`, `ci`, the
  console, and the SDK behave identically on every platform session.
- `tendb snapshots create` and `tendb schema sync` ride the same
  request-nonce protocol everywhere; only the store holding the nonce
  differs.
- "Platform down" is the same signal everywhere: a missing `instance-id`
  param means nothing exists, the CLI exits 10, and `tendb ci delete`
  treats it as already-clean (exit 0).
