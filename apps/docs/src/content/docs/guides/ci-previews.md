---
title: CI preview environments
description: Give every pull request its own writable Postgres branch with tendb ci, and tear it down when the PR closes.
---

Every pull request can get its own writable copy of your production-shaped database in seconds. A branch is a ZFS copy-on-write clone on your engine host — it costs only the pages the PR changes, and deleting it is instant.

`tendb ci` is the script-facing contract for exactly this. It has three verbs:

```bash
tendb ci ensure 42   # branch + clone exist and are ready; prints the URI
tendb ci url 42      # URI of an existing branch (no side effects)
tendb ci delete 42   # tear it down; safe to run unconditionally
```

The lifecycle maps 1:1 onto PR events:

```
PR opened / updated ──▶ tendb ci ensure 42 ──▶ postgres://pr_42:…@host:6001/app
                            (idempotent — same URI on every run)

PR closed ──────────────▶ tendb ci delete 42 ──▶ exit 0
                            (even if the branch is gone or the platform is down)
```

## The contract

`tendb ci` is a drop-in for shell pipelines, with hard guarantees:

- **The connection URI is the last line on stdout.** Everything else — progress, warnings — goes to stderr. Capture it with `| tail -1`.
- **A bare number `N` means branch `pr-N`.** `tendb ci ensure 42` operates on branch `pr-42`.
- **`ci delete` exits 0 when there is nothing to delete** — including when the whole platform is torn down.

```bash
URI=$(tendb ci ensure "$PR_NUMBER" | tail -1)
echo "::add-mask::$URI"   # the URI contains a live password
```

The contract is *last line*, not *only line* — `tail -1` is the reliable capture even if a future version adds stdout output above the URI.

### Branch naming and credentials

- Names must match `[a-z0-9][a-z0-9-]*` (max 63 chars); anything else exits 2.
- The branch name, the DBLab clone id, and the DBLab branch name are the same string.
- The Postgres user is the name with dashes turned to underscores: `pr-42` → `pr_42`.
- The password is derived statelessly from the engine's verification token and the branch name — nothing is stored anywhere, and every rerun of `ensure` prints the identical URI.

### `ensure` semantics

`tendb ci ensure <id>` is fully idempotent — safe to run on every push to the PR:

1. If the branch's clone exists and is in state `OK`, it short-circuits and prints the URI. Nothing is recreated; PR data survives across pushes.
2. If the clone exists but is wedged (any non-`OK` state), it is deleted and recreated.
3. Otherwise it waits for the engine's first snapshot to exist, creates the DBLab branch (always from `main` — `ci ensure` has no `--from`), creates the clone, and waits for it to reach `OK` (up to `cloneTimeoutSeconds`, default 120 s).

:::caution
Right after a fresh `terraform apply`, the engine may still be building its first snapshot. `ci ensure` waits up to `snapshotTimeoutSeconds` (default **900 s = 15 minutes**) before failing with exit 4 — give the job a timeout larger than that, or lower the setting in [configuration](/reference/configuration/).
:::

If you need previews cut from a branch other than `main`, use `tendb branches create <name> --from <base>` instead — it is equally idempotent and also prints the URI on stdout. See the [CLI reference](/reference/cli/).

### `delete` semantics

`tendb ci delete <id>` deletes the clone, waits for it to disappear, then deletes the branch. It tolerates every flavor of "already gone":

- Branch or clone never existed → exit 0.
- Platform torn down (the SSM discovery parameters are missing) → exit 0, with a stderr note: `DBLab host absent — nothing to delete`.

That makes PR-close cleanup unconditional — no guards, no `continue-on-error`.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success — including `ci delete` of an absent branch or a torn-down platform |
| 1 | Generic / API error |
| 2 | Usage error (invalid branch name, bad flag) |
| 3 | Branch not found (`ci url` only) |
| 4 | Timeout — no snapshot after 15 min, or the clone never reached `OK` |
| 5 | Missing local dependency (`session-manager-plugin`) |
| 10 | Platform down — SSM `instance-id` / token parameter missing |
| 42 | Clone capacity exhausted (port pool full) |

:::caution[Platform-down asymmetry]
Only `ci delete` converts platform-down to exit 0. **`ci ensure` and `ci url` exit 10** when the platform is down. If you deliberately turn the platform off sometimes, decide what your PR-open workflow does with exit 10 — usually "skip the preview", not "fail the build".
:::

## GitHub Actions setup

Three pieces of one-time setup, then two small workflows.

### 1. AWS auth: an OIDC role with the client policy

The CLI talks to AWS through SSM only: it reads the discovery parameters (including the SecureString verification token) and opens Session Manager port-forwards. The engine Terraform module emits a ready-made IAM policy with exactly those permissions — see the [engine module reference](/reference/terraform-engine/).

Create a role GitHub Actions can assume via OIDC and attach the policy:

```hcl
data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

resource "aws_iam_role" "tendb_ci" {
  name = "tendb-ci"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = data.aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = { "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com" }
        StringLike   = { "token.actions.githubusercontent.com:sub" = "repo:your-org/your-repo:*" }
      }
    }]
  })
}

resource "aws_iam_role_policy" "tendb_client" {
  name   = "tendb-client"
  role   = aws_iam_role.tendb_ci.id
  policy = module.engine.client_iam_policy_json
}
```

Prefer a managed policy? Set `create_client_iam_policy = true` on the engine module and attach `module.engine.client_iam_policy_arn` with an `aws_iam_role_policy_attachment` instead.

The policy grants: `ssm:StartSession` on the port-forwarding document and (tag-conditioned, so it survives instance replacement) on the engine instance, session housekeeping (`ssm:TerminateSession`, `ssm:GetCommandInvocation`), and `ssm:GetParameter` on everything under your SSM prefix.

:::note
The verification token is the root secret — anyone who can read it can derive every branch password. Scope the OIDC trust condition (`sub`) tightly to the repos that need previews. More in the [security model](/concepts/security/).
:::

### 2. Pin region and SSM prefix

The CLI needs to know your AWS region and the SSM prefix the Terraform module used. Commit a `tendb.json` at the repo root — it is discovered automatically:

```json
{
  "ssmPrefix": "/tendb",
  "region": "eu-north-1"
}
```

Or set env vars in the workflow (`TENDB_SSM_PREFIX`, `TENDB_REGION`), or pass flags — which must come **after** the subcommand:

```bash
tendb ci ensure 42 --region eu-north-1 --ssm-prefix /tendb
```

Precedence is flags > `TENDB_*` env vars > `tendb.json` > defaults (the default prefix is `/tendb`). Note that `AWS_REGION` — which `aws-actions/configure-aws-credentials` sets — sits at the env-var tier, so it overrides a `region` in `tendb.json`. Usually that is what you want; just don't expect the file to win. Full details in [configuration](/reference/configuration/).

### 3. Install the Session Manager plugin

The CLI spawns `session-manager-plugin` for its SSM tunnels; without it, commands exit 5. On Ubuntu runners:

```yaml
- name: Install session-manager-plugin
  run: |
    curl -fsSL https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb -o /tmp/smp.deb
    sudo dpkg -i /tmp/smp.deb
```

## The workflows

### On PR open / update: ensure the branch

```yaml
# .github/workflows/pr-preview.yml
name: pr-preview

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  id-token: write   # OIDC
  contents: read

concurrency:
  group: pr-preview-${{ github.event.pull_request.number }}
  cancel-in-progress: false

env:
  TENDB_SSM_PREFIX: /tendb

jobs:
  preview:
    runs-on: ubuntu-latest
    timeout-minutes: 20   # first-ever run may wait for the engine's first snapshot
    steps:
      - uses: actions/checkout@v4

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/tendb-ci
          aws-region: eu-north-1

      - name: Install session-manager-plugin
        run: |
          curl -fsSL https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb -o /tmp/smp.deb
          sudo dpkg -i /tmp/smp.deb

      - name: Install tendb
        run: npm install -g @10play/tendb

      - name: Ensure preview branch
        id: branch
        shell: bash   # explicit bash enables pipefail, so a tendb failure fails the step
        run: |
          URI=$(tendb ci ensure "${{ github.event.pull_request.number }}" | tail -1)
          echo "::add-mask::$URI"
          echo "uri=$URI" >> "$GITHUB_OUTPUT"

      - name: Run migrations on the branch
        run: tendb migrate "${{ github.event.pull_request.number }}" -- npx prisma migrate deploy

      - name: Deploy preview
        env:
          DATABASE_URL: ${{ steps.branch.outputs.uri }}
        run: ./scripts/deploy-preview.sh
```

What each piece is doing:

- **`concurrency`** serializes runs per PR. `ensure` is idempotent, but two concurrent runs racing a wedged clone's delete-and-recreate is a race you don't need.
- **`shell: bash`** on the ensure step matters: GitHub's implicit default shell does *not* set `pipefail`, so `tendb ci ensure … | tail -1` would report `tail`'s exit 0 even when tendb fails. An explicit `shell: bash` adds `-o pipefail`.
- **`::add-mask::`** before writing the output — the URI embeds a real password, and every later `echo` of it would land in the logs otherwise.
- **`tendb migrate <pr> -- <cmd>`** runs your migration tool with `DATABASE_URL` pointed at the branch *through an automatic SSM tunnel*, and exits with the tool's own exit code. Bare PR numbers work here too.

:::caution[The URI is an in-VPC address]
The URI printed by `ensure` points at the engine host's address inside your VPC. A GitHub-hosted runner cannot dial it directly — only steps that go through the SSM tunnel (`tendb migrate … -- cmd`, `tendb tunnel <name> -- cmd`, `tendb psql`) can reach the database from the runner. The injected `DATABASE_URL` is for the **deployed preview app**, which must run somewhere with network access to the VPC (same VPC, peering, or VPN). See [architecture](/concepts/architecture/).
:::

### On PR close: delete the branch

```yaml
# .github/workflows/pr-preview-cleanup.yml
name: pr-preview-cleanup

on:
  pull_request:
    types: [closed]

permissions:
  id-token: write
  contents: read

concurrency:
  group: pr-preview-${{ github.event.pull_request.number }}

env:
  TENDB_SSM_PREFIX: /tendb

jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/tendb-ci
          aws-region: eu-north-1

      - name: Install session-manager-plugin
        run: |
          curl -fsSL https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb -o /tmp/smp.deb
          sudo dpkg -i /tmp/smp.deb

      - name: Install tendb
        run: npm install -g @10play/tendb

      - name: Delete preview branch
        run: tendb ci delete "${{ github.event.pull_request.number }}"
```

No guards needed: `ci delete` exits 0 if the branch never existed, was already cleaned up, or the platform itself is gone. Using the **same concurrency group** as the preview workflow means a close event queues behind an in-flight ensure instead of racing it — concurrency groups are shared across workflows in a repo.

### Handling a deliberately-off platform

If you shut the platform down outside working hours, `ci ensure` exits 10 during that window. Convert it to a skip instead of a failure:

```yaml
- name: Ensure preview branch
  id: branch
  shell: bash
  run: |
    set +e
    URI=$(tendb ci ensure "${{ github.event.pull_request.number }}" | tail -1)
    code=$?
    set -e
    if [ "$code" -eq 10 ]; then
      echo "platform is down — skipping preview" >&2
      echo "skipped=true" >> "$GITHUB_OUTPUT"
      exit 0
    fi
    [ "$code" -ne 0 ] && exit "$code"
    echo "::add-mask::$URI"
    echo "uri=$URI" >> "$GITHUB_OUTPUT"
```

Gate the later steps on `steps.branch.outputs.skipped != 'true'`.

## Self-hosted runners inside the VPC

A runner that already has network access to the engine host can skip AWS entirely with direct mode: set `TENDB_API_URL` (the engine API, port 2345), `TENDB_TOKEN`, and `TENDB_DATABASE`. No OIDC role, no `session-manager-plugin`. Port-forwarding commands are unavailable in direct mode, but the URIs are dialable as-is from inside the VPC. See [configuration](/reference/configuration/).

## Gotchas

**Keep stdout clean.** The contract is "URI on the last stdout line". Wrappers that print after tendb break `tail -1` — the classic offender is `npm run db:preview`, whose banner also lands on stdout. Call the `tendb` binary directly, or use `npm run --silent`.

**`tail -1` swallows exit codes without pipefail.** Covered above — use `shell: bash` or `set -o pipefail` wherever you pipe tendb's output.

**Masked values don't cross job boundaries.** GitHub drops job outputs that contain masked content. Keep `ensure` and its consumers in the same job, or have the other job run `tendb ci url <pr> | tail -1` to re-derive the URI itself (and mask it again there).

**Capacity is a fixed port pool.** Each engine host serves a fixed number of concurrent branches (the Terraform `clone_port_range`). When it's full, `ensure` exits **42**. The engine does reap clones idle longer than `clone_max_idle_minutes` (default 24 h), but a branch something keeps connecting to never idles — a PR closed while your cleanup workflow was broken can hold a port indefinitely. Check with `tendb branches list`, delete idle ones, or grow the pool. A scheduled job that reconciles open PRs against `tendb branches list -o json` is cheap insurance. See [operations](/guides/operations/).

**Global flags go after the subcommand.** `tendb --region eu-north-1 ci ensure 42` is an error; `tendb ci ensure 42 --region eu-north-1` works.

**`ci ensure` always branches from `main`.** Data written to a PR branch persists across `ensure` reruns; to restart a PR's database from a clean snapshot, run `tendb branches reset pr-42` (or `delete` then `ensure`).

Under the hood, branches are thin clones served by [DBLab Engine](https://postgres.ai/) — the [architecture page](/concepts/architecture/) explains how the engine host, snapshots, and clones fit together.
