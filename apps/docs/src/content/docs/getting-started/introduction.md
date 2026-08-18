---
title: What is tendb?
description: Why tendb exists, the one-paragraph mental model, who it is for, and when not to use it.
---

tendb is a self-hosted Neon alternative: database branching for Postgres, on
infrastructure you own. It gives every developer and every pull request its
own writable copy of your real Postgres database — in seconds, on an EC2 host
in your own AWS account.

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

<figure class="diagram">
<div class="scroll">
<svg viewBox="0 0 966 240" role="img" aria-label="tendb overview: the tendb clients reach one EC2 host in your AWS account through SSM Session Manager port-forwards; the host syncs from your source Postgres and serves copy-on-write clone databases" font-family="ui-sans-serif, system-ui, sans-serif" font-size="13" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
<defs>
<marker id="intro-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path d="M0 0 10 5 0 10z" fill="currentColor"/>
</marker>
</defs>
<rect x="20" y="90" width="150" height="84" rx="10" fill="currentColor" fill-opacity="0.03" stroke="currentColor" stroke-opacity="0.35"/>
<text x="38" y="118" font-size="14" font-weight="600" fill="var(--sl-color-accent)">tendb</text>
<text x="38" y="140" font-size="12" fill-opacity="0.62">CLI · web console</text>
<text x="38" y="158" font-size="12" fill-opacity="0.62">CI · SDK</text>
<line x1="170" y1="132" x2="312" y2="132" stroke="currentColor" stroke-width="1.5" marker-end="url(#intro-arrow)"/>
<text x="236" y="106" text-anchor="middle">SSM Session Manager</text>
<text x="236" y="123" text-anchor="middle">port-forwards</text>
<text x="304" y="34" font-size="11" letter-spacing="1.5" fill-opacity="0.6">AWS ACCOUNT (YOURS)</text>
<rect x="300" y="44" width="332" height="176" rx="10" fill="none" stroke="currentColor" stroke-opacity="0.3" stroke-dasharray="6 6"/>
<rect x="316" y="60" width="300" height="144" rx="10" fill="currentColor" fill-opacity="0.03" stroke="currentColor" stroke-opacity="0.35"/>
<text x="332" y="84"><tspan font-weight="600">EC2 host</tspan> <tspan fill-opacity="0.62">— ZFS + DBLab Engine</tspan></text>
<rect x="332" y="98" width="268" height="32" rx="8" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.22"/>
<text x="348" y="119"><tspan font-weight="600">dblab-server</tspan> <tspan font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">:2345</tspan></text>
<rect x="332" y="144" width="84" height="26" rx="13" fill="var(--sl-color-accent)" fill-opacity="0.12" stroke="var(--sl-color-accent)" stroke-opacity="0.7"/>
<text x="374" y="161" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11.5" fill="var(--sl-color-accent)">clone :6000</text>
<rect x="424" y="144" width="84" height="26" rx="13" fill="var(--sl-color-accent)" fill-opacity="0.12" stroke="var(--sl-color-accent)" stroke-opacity="0.7"/>
<text x="466" y="161" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11.5" fill="var(--sl-color-accent)">clone :6001</text>
<rect x="516" y="144" width="84" height="26" rx="13" fill="var(--sl-color-accent)" fill-opacity="0.12" stroke="var(--sl-color-accent)" stroke-opacity="0.7"/>
<text x="558" y="161" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11.5" fill="var(--sl-color-accent)">clone :6002</text>
<text x="332" y="192" font-size="12" fill-opacity="0.62">no SSH, no inbound internet</text>
<line x1="760" y1="132" x2="620" y2="132" stroke="currentColor" stroke-width="1.5" marker-end="url(#intro-arrow)"/>
<text x="696" y="118" text-anchor="middle">sync</text>
<text x="696" y="156" text-anchor="middle" font-size="12" fill-opacity="0.62">nightly dump/restore</text>
<text x="696" y="174" text-anchor="middle" font-size="12" fill-opacity="0.62">or streaming</text>
<rect x="760" y="102" width="186" height="60" rx="10" fill="none" stroke="currentColor" stroke-opacity="0.35" stroke-dasharray="6 5"/>
<text x="853" y="126" text-anchor="middle" font-weight="600">source Postgres</text>
<text x="853" y="148" text-anchor="middle" font-size="12" fill-opacity="0.62">Neon · Aurora · RDS · any URL</text>
</svg>
</div>
<figcaption>One EC2 host in your AWS account: clients tunnel in over SSM, data syncs in from your source Postgres, and every branch is a clone on its own port.</figcaption>
</figure>

## A four-line session

```bash
tendb branches create my-feature   # copy-on-write branch DB, ready in ~5s
tendb psql my-feature              # auto tunnel + psql
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

Getting the infrastructure up is one command from any project —
`npx @10play/tendb init` scaffolds the Terraform and config, `tendb up`
applies it. Walk through it in the [Quickstart](/getting-started/quickstart/)
(AWS) or the [local quickstart](/getting-started/local-quickstart/) (Docker on
your laptop, no cloud account), browse the runnable
[example app](https://github.com/10play/tendb/tree/main/apps/example), or read
the [architecture](/concepts/architecture/) in depth.
