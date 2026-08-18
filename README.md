# tendb

Neon-style Postgres branching on your own infrastructure — AWS, GCP, Azure,
or your laptop's Docker — powered by [DBLab Engine](https://postgres.ai).
This is a pnpm monorepo; the product lives in
[`packages/tendb/`](packages/tendb/README.md):

- `packages/tendb/terraform/` — per-platform engine/network/console modules
  (`modules/aws|gcp|azure|local`) behind one
  [engine contract](packages/tendb/terraform/docs/ENGINE-CONTRACT.md), plus
  the `examples/standalone` deployment used for the live AWS environment.
- `packages/tendb/cli/` — the `@10play/tendb` CLI and the bundled web console
  (`--platform aws|gcp|azure|local`).
- `packages/tendb/snapshotd/` — the on-host snapshot/schema executor.
- `apps/docs/` — the documentation site (Astro Starlight): quickstart,
  architecture, CLI & Terraform reference, CI previews, Neon parity.

## Documentation

**Live: https://10play.github.io/tendb/** (served from the `gh-pages` branch)

```bash
pnpm install
pnpm docs:dev      # http://localhost:4321
pnpm docs:build    # static site in apps/docs/dist/
```

The repo-root `tendb.json` points the CLI at the live engine
(`/tendb` SSM prefix, eu-north-1), so from anywhere in the repo:

```bash
tendb status
tendb branches create my-feature
tendb psql my-feature
```

See [`packages/tendb/README.md`](packages/tendb/README.md) for architecture,
sizing and the CI contract.

> **Note:** the live AWS resources were provisioned under the old `pgbranch`
> name (SSM prefix `/pgbranch`, secrets `pgbranch/console-oauth` and
> `pgbranch-smoke/source-url`, bucket `pgbranch-pkg-409154939891`). The config
> and terraform in this repo now use `tendb` — rename the AWS resources or
> re-apply terraform before the CLI can reach the engine again.

## Acknowledgements

tendb is built on [DBLab Engine](https://github.com/postgres-ai/database-lab-engine)
(Database Lab Engine) by [Postgres.ai](https://postgres.ai) — the open-source
engine that does the heavy lifting: ZFS thin cloning and copy-on-write branch
databases. tendb adds the AWS packaging around it (Terraform provisioning, SSM
transport, the CLI, the web console, and the CI contract).
