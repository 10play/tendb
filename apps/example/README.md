# tendb example app

A tiny demo project living on a **local** tendb platform: Postgres branches
served from Docker containers on your own machine — no cloud account.
`tendb/` is the unedited output of `npx @10play/tendb init --platform local`.

## Run it

Prereqs: Node ≥ 20, pnpm, **Terraform ≥ 1.11**, and on macOS Homebrew — the
preflight installs a colima VM (Docker Desktop won't work — its kernel has no
ZFS). The VM defaults to 4 CPUs / 8 GB RAM / 60 GB disk with a 20 GB pool
(`TENDB_VM_*` / `TENDB_POOL_SIZE` env vars override).

```bash
pnpm install
pnpm build            # builds the workspace CLI this example runs
pnpm example:up       # preflight (colima+zpool) + terraform apply
pnpm example:demo     # branch → migrate → query → delete
pnpm example:down     # destroy the containers
```

The demo proves the whole loop: it creates branch `demo` (copy-on-write,
~5s), rehearses `migrations/001_add_status.sql` on it via `tendb migrate`,
queries the branch over the `ci url` contract, then deletes the branch. You
should see:

```
users: 500, orders with the migrated column: 5000

=== delete branch "demo"
...
=== done — production never saw any of that
```

The seeded "production" source is a demo Postgres container — point
`source_url` in `tendb/terraform.tfvars` at a real database to branch from
your own data.

Poke around interactively (from `apps/example`, where the CLI is wired up):

```bash
cd apps/example
pnpm exec tendb status
pnpm exec tendb branches create my-feature
pnpm exec tendb psql my-feature
pnpm exec tendb console
```

## About `tendb/`

The committed scaffold uses *relative* Terraform module sources so it
validates against this repo; scaffolding outside the repo pins them to a git
ref instead. Regenerate it after scaffolder changes with `pnpm scaffold`
(from `apps/example`) — CI diffs a fresh render against these files.
