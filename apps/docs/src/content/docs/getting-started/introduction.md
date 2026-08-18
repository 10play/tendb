---
title: What is tendb?
description: Why tendb exists, the one-paragraph mental model, who it is for, and when not to use it.
---

tendb gives every developer and every pull request its own writable copy of
your real Postgres database — in seconds, on an EC2 host in your own AWS
account.

## The problem

Development and CI rarely run against realistic data. Seed scripts drift from
production. The shared staging database is stale, contended, and nobody dares
reset it. Restoring a full copy of production for one experiment takes hours
and real money per copy — so nobody does it, and the bugs that only reproduce
at production data shape and volume ship anyway.

Managed platforms like Neon solved this with database branching. But that
means your data lives on their infrastructure. If your database has to stay
in your AWS account — or already lives happily on Aurora or RDS — you don't
get the branching workflow.

## What tendb does

tendb brings the Neon-style branching workflow to infrastructure you own:

- **Branch databases in seconds.** `tendb branches create my-feature` prints
  a `postgres://` URI for a real, writable Postgres backed by a
  copy-on-write clone. A branch costs only the disk pages you change.
- **Disposable by design.** Reset a branch to its starting snapshot, or
  delete it and make another. Nothing you do on a branch touches the source.
- **A full toolkit.** A `neonctl`-style CLI, a local web console (SQL editor,
  branch tree, monitoring, alerts), a CI contract for PR preview databases,
  and Terraform modules that provision everything.

## The mental model

tendb is one EC2 host in your AWS account. The bundled Terraform provisions
it with ZFS on a gp3 volume and installs
[DBLab Engine](https://github.com/postgres-ai/database-lab-engine) (by
Postgres.ai), which does the thin cloning. The host syncs from your source
Postgres — Neon, Aurora, RDS, anything with a URL — via nightly dump/restore
or continuous logical replication. Every branch is a ZFS copy-on-write clone
of that synced data, served as its own Postgres on its own port. The host has
no SSH and no inbound internet: the CLI discovers it through SSM parameters,
reaches it through SSM Session Manager port-forwards, and derives clone
passwords locally — no credentials are stored anywhere.

```
                 AWS account (yours)
  ┌───────────────────────────────────────────────┐
  │  EC2 host — ZFS + DBLab Engine                │        sync
  │  ┌─────────────────────────────────────────┐  │  ◄───────────────  source Postgres
  │  │ dblab-server :2345                      │  │   (dump/restore    (Neon, Aurora,
  │  │ clone :6000   clone :6001   clone :6002 │  │    or streaming)    RDS, any URL)
  │  └─────────────────────────────────────────┘  │
  │        ▲  no SSH, no inbound internet         │
  └────────┼──────────────────────────────────────┘
           │  SSM Session Manager port-forwards
     ┌─────┴─────┐
     │   tendb   │   CLI · web console · CI · SDK
     └───────────┘
```

## A four-line session

```bash
tendb branches create my-feature   # copy-on-write branch DB, ready in ~5s
tendb psql my-feature              # auto SSM tunnel + psql
tendb console                      # Neon-style dashboard on localhost
tendb ci ensure 42 | tail -1       # CI: connection URI as the last stdout line
```

## Who it's for

- **Teams on Aurora, RDS, Neon, or any managed Postgres** who want
  branch-per-PR preview databases with production-like data — without moving
  production anywhere.
- **Developers** who want a disposable, writable, prod-shaped database for a
  feature branch instead of a shared staging server.
- **Migration rehearsal**: `tendb migrate --scratch -- npx prisma migrate deploy`
  runs your migration tool against an ephemeral branch and cleans up after
  itself, even on failure.
- **Teams with data-residency requirements**: everything stays inside your
  VPC, reachable only over AWS IAM/SSM.

## When not to use tendb

tendb is deliberately not a managed database platform. Skip it if you need:

- **Serverless compute.** There is no autoscaling, no scale-to-zero, and no
  per-branch compute sizing — every branch runs on the same fixed-size host,
  and capacity is a fixed port pool (10–50 concurrent branches depending on
  host size).
- **Point-in-time recovery.** Branch points are the host's snapshots
  (scheduled or on-demand) — there is no WAL archive and no "branch as of an
  arbitrary timestamp".
- **High availability.** It's a single host, and branches are disposable by
  design: replacing the instance destroys all clones and re-syncs from
  source.
- **Public endpoints.** Branches are reachable in-VPC or through SSM tunnels
  only — there are no public TLS connection strings to hand to an
  internet-facing app.
- **A production database.** tendb branches are for development, CI, and
  experimentation. Your production keeps running wherever it already runs;
  tendb only reads from it.

:::note
tendb complements your primary database rather than replacing it. For the
full feature-by-feature comparison with Neon, see
[Neon parity](/comparison/neon-parity/).
:::

## Next steps

Deploy the host and create your first branch in the
[Quickstart](/getting-started/quickstart/), or read the
[architecture](/concepts/architecture/) in depth.
