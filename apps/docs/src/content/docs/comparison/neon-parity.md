---
title: tendb vs Neon
description: An honest feature-parity comparison between Neon branching and tendb's self-hosted branch databases.
---

If you use Neon for branch-per-PR development, tendb gives you the same day-to-day workflow — instant copy-on-write branches, a connection string per branch, a CLI, a web console, and a CI contract — running on a single EC2 host in **your own AWS account**, powered by [DBLab Engine](https://postgres.ai/products/how-it-works) (ZFS thin clones). The fundamental difference: Neon is managed serverless Postgres where branches fork the live parent at the instant you create them; tendb is a self-hosted clone host that **syncs from a source database** (Neon, Aurora, RDS, any Postgres URL) and branches from the last sync, not from live production. Your source stays wherever it is — tendb can even use a Neon production database as its source.

## Feature parity table

Honest in both directions. tendb claims are grounded in the CLI and console source; Neon claims reflect Neon's documented product as of mid-2026 — check [neon.com/docs](https://neon.com/docs) for current plan limits.

| Feature | Neon | tendb | Notes |
| --- | --- | --- | --- |
| Branch create / delete / list | Yes (`neonctl`, console, API) | Yes (`tendb branches create\|list\|get\|delete`, console, SDK) | tendb create is idempotent create-or-reuse; delete of an absent branch exits 0. Bare numbers are PR shorthand: `42` → `pr-42`. |
| Branch reset | Yes — `neonctl branches reset <branch> --parent` resets to the parent's **latest** state | Yes — `tendb branches reset <name>` discards writes, back to the branch's **own** snapshot | Different semantics. To pick up newer data in tendb, delete and recreate the branch (optionally with `--fresh`). |
| Branch-from-branch | Yes (`--parent`) | Yes (`--from <branch>`, default `main`) | `--from` is honored only when the branch doesn't already exist. |
| Time-to-branch | Seconds (storage-level copy-on-write) | Seconds (ZFS copy-on-write clone) | tendb footgun: right after first provisioning, the first branch waits for the first sync snapshot — up to 15 minutes. |
| Connection string per branch | Yes — public TLS endpoint per branch, pooled variant available | Yes — `postgres://` URI per branch with stateless derived credentials | tendb URIs are in-VPC only: reachable from inside your VPC or through an SSM tunnel. No public endpoint, no TLS, by design. |
| psql access | `psql "$(neonctl connection-string my-branch)"` over the internet | `tendb psql my-branch` — opens an SSM tunnel automatically | No VPN or bastion needed; auth is your AWS IAM credentials. |
| CLI | `neonctl` (projects, branches, databases, roles, …) | `tendb` (branches, snapshots, schema, migrate, checkup, ci, console) | tendb has no project/org/role management — one engine is one implicit project with one database. |
| Web console | Full SaaS console (console.neon.tech) | `tendb console` — local dashboard: branches, snapshots, alerts, tables, SQL editor, per-branch monitoring | tendb's console runs on your machine (or self-hosted behind an auth proxy); secrets never reach the browser. |
| CI previews | Official GitHub Actions, Vercel/Netlify integrations | `tendb ci ensure\|url\|delete` — a strict stdout contract you wire into any CI | No prebuilt Action shipped; the wiring is a few lines of workflow YAML. See [CI previews](/guides/ci-previews/). |
| Snapshots | Restore points across the history retention window, plus explicit snapshots | Explicit ZFS pool snapshots — scheduled or `tendb snapshots create` (~10 s at any size) | tendb snapshots are the *only* available branch points. On-demand snapshots require the streaming deployment. |
| Schema diff | `neonctl branches schema-diff` — branch vs. branch | `tendb schema diff` — **source vs. sync target drift only** | Not equivalent. tendb has no branch-to-branch schema diff; use your migration tool's diff instead. |
| Scale-to-zero / autoscaling | Yes — computes suspend when idle and autoscale under load | No — all branches run on one fixed-size host | tendb capacity is a static port pool (e.g. 10 concurrent branches); exhaustion is a distinct exit code 42. |
| Point-in-time restore | Yes — branch or restore from any timestamp/LSN in the retention window (hours to weeks by plan) | No — no WAL archive, no arbitrary-timestamp branches | tendb branch points are exactly its snapshots. tendb is not a backup tool; keep your source's own PITR. |
| Read replicas | Yes — read-only computes on a branch | No | Closest analog: in streaming mode, `main` is a live read-only view of the sync target. |
| High availability | Managed — replicated storage, compute rescheduled on failure | No — single engine host | If the host dies, `terraform apply` rebuilds it and it resyncs. Branches are disposable; your source database is never at risk. |
| Managed-ness | Fully managed SaaS | Self-hosted: Terraform-provisioned EC2, you operate it | `tendb checkup`, `tendb status`, and console Slack alerts do the watching; you do the acting. See [Operations](/guides/operations/). |
| Data freshness | Branches fork the **live** parent at creation time | Branches are of the **last sync**: nightly in dump mode, near-live in streaming mode (`--fresh` snapshots first) | The flip side: branch workloads can never load or endanger production, and production credentials never reach developers. See [Data refresh](/concepts/data-refresh/). |
| Where data lives | Neon-operated cloud regions | Your AWS account, your VPC | Data never leaves your account — relevant for compliance and data residency. |
| Cost model | Usage-based: compute hours + storage, scale-to-zero trims idle cost; free tier | Fixed: one EC2 instance + EBS, whatever your AWS pricing says | tendb costs the same with 1 branch or 10 — each branch stores only the blocks it changes. No per-seat or plan limits. |

Things Neon has that tendb has no equivalent for at all: connection pooler endpoints, a serverless/HTTP driver, branch protection and expiry/TTL, IP allow-lists, multi-region, org/project hierarchy, usage metering, and the Neon extras (Auth, Data API). Things tendb has that Neon doesn't: it works with *any* source Postgres — your production can stay on Aurora, RDS, or Neon itself.

## When to pick which

**Pick Neon** when you want production itself to be serverless managed Postgres: scale-to-zero for spiky workloads, PITR, read replicas, HA, and zero servers to operate. If your production database can live in Neon's cloud, branching there is the shortest path.

**Pick tendb** when:

- Production already lives on RDS, Aurora, or another Postgres you can't (or won't) move — tendb bolts Neon-style branching onto it without a migration.
- Data must stay in your AWS account. Branch databases, connection strings, and the console all live inside your VPC; access rides on AWS IAM + SSM.
- You want a fixed, predictable bill. One EC2 host serves every branch; a busy PR week costs the same as a quiet one.
- You want branches of **production-sized, production-shaped data** that can never touch production — branch workloads run on a synced copy, and the SQL editor and migrations get full write access precisely because clones are disposable.

**Use both.** tendb's source is any Postgres URL, so a common setup is Neon (or Aurora) as production and tendb serving the disposable copies:

<figure class="diagram">
<div class="scroll">
<svg viewBox="0 0 720 220" role="img" aria-label="Combined topology: Neon production stays managed while the tendb host (EC2 + ZFS) syncs from it via nightly dump or logical replication and serves copy-on-write clones pr-42, pr-43, and staging" font-family="ui-sans-serif, system-ui, sans-serif" font-size="13" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
<defs>
<marker id="neon-parity-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path d="M0 0 10 5 0 10z" fill="currentColor"/>
</marker>
</defs>
<rect x="32" y="87" width="176" height="52" rx="10" fill="none" stroke="currentColor" stroke-opacity="0.35" stroke-dasharray="6 5"/>
<text x="120" y="118" text-anchor="middle" font-size="14" font-weight="600">Neon production</text>
<line x1="208" y1="113" x2="338" y2="113" stroke="currentColor" stroke-width="1.5" marker-end="url(#neon-parity-arrow)"/>
<text x="273" y="84" text-anchor="middle">nightly dump /</text>
<text x="273" y="102" text-anchor="middle">logical replication</text>
<rect x="344" y="77" width="144" height="72" rx="10" fill="currentColor" fill-opacity="0.03" stroke="currentColor" stroke-opacity="0.35"/>
<text x="416" y="107" text-anchor="middle" font-size="14" font-weight="600">tendb host</text>
<text x="416" y="129" text-anchor="middle" font-size="12" fill-opacity="0.62">EC2 + ZFS</text>
<line x1="488" y1="113" x2="586" y2="53" stroke="currentColor" stroke-width="1.5" marker-end="url(#neon-parity-arrow)"/>
<line x1="488" y1="113" x2="586" y2="113" stroke="currentColor" stroke-width="1.5" marker-end="url(#neon-parity-arrow)"/>
<line x1="488" y1="113" x2="586" y2="173" stroke="currentColor" stroke-width="1.5" marker-end="url(#neon-parity-arrow)"/>
<text x="640" y="24" text-anchor="middle" font-size="12" fill-opacity="0.62">CoW clones</text>
<rect x="592" y="40" width="96" height="26" rx="13" fill="var(--sl-color-accent)" fill-opacity="0.12" stroke="var(--sl-color-accent)" stroke-opacity="0.7"/>
<text x="640" y="57" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12" fill="var(--sl-color-accent)">pr-42</text>
<rect x="592" y="100" width="96" height="26" rx="13" fill="var(--sl-color-accent)" fill-opacity="0.12" stroke="var(--sl-color-accent)" stroke-opacity="0.7"/>
<text x="640" y="117" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12" fill="var(--sl-color-accent)">pr-43</text>
<rect x="592" y="160" width="96" height="26" rx="13" fill="var(--sl-color-accent)" fill-opacity="0.12" stroke="var(--sl-color-accent)" stroke-opacity="0.7"/>
<text x="640" y="177" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12" fill="var(--sl-color-accent)">staging</text>
</svg>
</div>
<figcaption>Neon keeps serving production while the tendb host syncs from it and fans out disposable copy-on-write branches.</figcaption>
</figure>

Production keeps its managed HA, PITR, and autoscaling; PR previews, migration rehearsals, and ad-hoc experiments hammer clones in your VPC instead of consuming production compute. Set it up in the [Quickstart](/getting-started/quickstart/).

:::caution
tendb branches are of the last sync, not live production. In dump mode that means "as of last night"; in streaming mode, `tendb branches create x --fresh` snapshots the sync target first for "as of right now". If you need a branch of production *at an arbitrary past moment*, that's PITR — use your source's PITR, not tendb.
:::

## neonctl → tendb translation

| You do this on Neon | You do this on tendb | Notes |
| --- | --- | --- |
| `neonctl branches create --name feat-x` | `tendb branches create feat-x` | Idempotent; prints the connection URI on stdout. |
| `neonctl branches create --name x --parent staging` | `tendb branches create x --from staging` | |
| `neonctl branches list` | `tendb branches list` | Add `-o json` for machine output. |
| `neonctl branches delete feat-x` | `tendb branches delete feat-x` | Exit 0 even if the branch is already gone. |
| `neonctl branches reset feat-x --parent` (discard writes, take parent's latest) | `tendb branches delete feat-x && tendb branches create feat-x --fresh` | Two steps because tendb separates the intents — see next row. |
| — (discard writes, keep the original branch point) | `tendb branches reset feat-x` | Back to the state the branch was created from. |
| `neonctl connection-string feat-x` | `tendb connection-string feat-x` | Both print the URI and nothing else. |
| `psql "$(neonctl connection-string feat-x)"` | `tendb psql feat-x` | tendb tunnels over SSM automatically. |
| `neonctl branches schema-diff main feat-x` | *(no equivalent)* | `tendb schema diff` checks source↔sync-target drift, a different job. |
| Create-branch GitHub Action on PR open | `URI=$(tendb ci ensure "$PR_NUMBER" \| tail -1)` | Mask it: `echo "::add-mask::$URI"`. Re-runs return the same URI. |
| Delete-branch GitHub Action on PR close | `tendb ci delete "$PR_NUMBER"` | Exits 0 even when the branch never existed or the platform is torn down. |
| Temporary branch for migration testing | `tendb migrate --scratch -- npx prisma migrate deploy` | Creates an ephemeral branch, runs the command, deletes it even on failure. |
| `neonctl projects list` | `tendb status` | One tendb engine = one implicit project. |

:::tip
Every tendb command that takes a branch name accepts a bare PR number: `tendb psql 42` connects to `pr-42`. Full flags and exit codes are in the [CLI reference](/reference/cli/).
:::
