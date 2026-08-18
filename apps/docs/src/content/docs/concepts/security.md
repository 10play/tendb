---
title: Security
description: tendb's security model — no SSH, no inbound internet, IAM-gated SSM access, a stateless token-derived credential scheme, and where each secret lives.
---

tendb's security posture is built on subtraction: no SSH, no inbound internet, no passwords stored anywhere, and no secrets in Terraform state. Access reduces to two questions — *can this principal call SSM against the host?* (IAM) and *does it hold the verification token?* (the one secret).

## No SSH, no inbound internet

The engine host is deliberately unreachable from the network:

- **No SSH.** The instance has no key pair and no port 22 anywhere. Administration happens through SSM Session Manager (the instance role carries `AmazonSSMManagedInstanceCore`).
- **Zero ingress by default.** The security group starts with no ingress rules at all. Client traffic — the DBLab API on 2345 and every clone's Postgres port — travels through SSM port-forwarding sessions, which are outbound WebSockets from the host's SSM agent to AWS. Nothing dials in.
- **IMDSv2 required.** The instance enforces token-based metadata access (`http_tokens = "required"`), closing off classic SSRF credential theft.
- **The embedded DBLab UI never leaves loopback.** It binds to `127.0.0.1:2346` on the host and is reachable only through an SSM tunnel (`tendb ui`).

Two opt-ins widen this, and only when you set them:

- `allowed_security_group_ids` / `allowed_cidr_blocks` open **direct TCP** to 2345 and the clone port range for in-VPC clients. SSM port-forwarding works regardless; these are for clients that skip it.
- `console_ingress = true` opens **80/443 to `0.0.0.0/0`** for a co-hosted web console fronted by Caddy.

:::caution
`console_ingress` is world-open by design — it exposes the console's login page to the internet, not to your allowlist. The console itself is then gated by Google login (see below), but don't flip this flag unless you're running the hosted console.
:::

Egress is unrestricted: the host needs outbound internet for apt, Docker Hub, the AWS APIs, and `pg_dump` against your source database.

## Access is IAM, not network

Because the only path to the host is SSM, "who can use tendb" is exactly "who IAM lets call `ssm:StartSession` on this instance and read the parameters under the prefix." There are no database-level user accounts to manage, no VPN membership, no bastion keys. Revoking a person or a CI role is an IAM detach.

### What the client IAM policy grants

The engine module renders a ready-made policy (output `client_iam_policy_json`, or a managed policy named `<name>-client` when `create_client_iam_policy = true`) to attach to CI roles and operator groups. It contains four statements:

| Statement | Actions | Scope |
|---|---|---|
| `SsmDocuments` | `ssm:SendCommand`, `ssm:StartSession` | Exactly two AWS documents: `AWS-StartPortForwardingSession` and `AWS-RunShellScript`, region-scoped |
| `SsmInstanceByTag` | `ssm:SendCommand`, `ssm:StartSession` | Any instance in the account **whose `Role` tag equals the configured value** — tag-conditioned so access survives instance replacement |
| `SsmSessionHousekeeping` | `ssm:GetCommandInvocation`, `ssm:TerminateSession` | `*` |
| `DiscoveryParams` | `ssm:GetParameter` | `parameter<ssm_prefix>/*` — **including the SecureString token**, because the CLI derives clone passwords locally from it |

Treat this policy as a database-admin credential: any principal holding it can read the token, and the token is full API access plus every clone password (see below). It grants nothing else — in particular, **no Secrets Manager access**: clients can never read your source database URL.

:::note
The token is encrypted with the default `aws/ssm` KMS key, which needs no extra grant. If you pass a customer-managed `kms_key_id`, you must grant `kms:Decrypt` on it to both the instance role and your client principals yourself.
:::

## The verification token

The DBLab API's `Verification-Token` is the platform's one shared secret, and it is handled so it never lands anywhere durable except SSM:

- **Generated ephemerally.** Terraform uses the ephemeral `aws_secretsmanager_random_password` resource (32 chars, no punctuation) purely as a generator — nothing is stored in Secrets Manager.
- **Written write-only.** The value goes into the SSM SecureString parameter `<prefix>/verification-token` via Terraform's `value_wo` argument, so **the token never enters Terraform state or plan output**. This is why the module requires Terraform >= 1.11.
- **Read by two parties**: the host at boot (under `set +x`, so it stays out of the boot trace log) to configure DBLab Engine, and CLI clients (via the `DiscoveryParams` grant) to authenticate API calls and derive passwords.

Rotation is `token_secret_version = 2` (or any bump) in Terraform — but read the next section before you do.

## Deterministic clone passwords

tendb stores no clone passwords anywhere. Each branch database's password is *derived*:

```
password = sha256("<token>:<branch>")  →  hex, first 32 chars
```

(The Postgres username is the branch name with dashes turned to underscores.) The CLI and the on-host tooling compute the identical value, so a clone created by either is reachable by both, and any machine that can read the token can construct any branch's connection string with zero lookups. This is what makes the whole system stateless — there is no credential store to sync, back up, or leak.

The trade-offs are the mirror image:

- **The token is the master key.** Reading `<prefix>/verification-token` yields every clone password, current and future. Scope the client policy accordingly.
- **Rotation invalidates all clones.** Bumping `token_secret_version` writes a new token, so every derived password changes — existing clones keep passwords derived from the *old* token and become unreachable by the CLI. The running server also read its token at boot, so it keeps honoring the old one until the instance is replaced. Rotate only when running clones are disposable, and plan an instance replacement as part of the rotation.

:::caution
Connection URIs printed by the CLI contain the real derived password, and `tendb ui` prints the token itself on stdout. In CI, mask the URI before anything else logs it:

```bash
URI=$(tendb ci ensure "$PR_NUMBER" | tail -1)
echo "::add-mask::$URI"
```
:::

Branch databases contain a full copy of your source data, so treat clone access as production-data access even though writes are isolated. If your source holds regulated data, that's an argument for masking or subsetting at the source before tendb dumps it.

## Where the source database URL lives

Your source Postgres URL — the highest-value credential in the system — sits in a **Secrets Manager secret you own** (`source_secret_arn`). tendb never copies it:

- The **host's instance role** is the only tendb principal that can read it: the boot policy grants `secretsmanager:GetSecretValue` on that ARN (and nothing else in Secrets Manager). The client policy has no Secrets Manager statements at all.
- The host pulls it **at boot, via its instance profile**, under `set +x` so it never appears in the boot log. It never transits Terraform state, user-data, plan output, or CI.
- If the secret is JSON, `source_secret_json_key` names the key holding the URL; otherwise the whole `SecretString` is the URL.

One nuance worth knowing: the boot policy matches `"${source_secret_arn}*"` — a trailing wildcard that tolerates name-form ARNs missing Secrets Manager's random suffix. It's a prefix match, so avoid giving other secrets ARNs that extend the source secret's name.

Also note the trust the host itself carries: the `dblab_server` container runs `--privileged` with the host's Docker socket mounted (it must spawn clone containers). Anyone authenticated to the API on 2345 is effectively root-adjacent on the host — one more reason the token and the client IAM policy deserve production-credential handling.

## The hosted console boundary

The local console (`tendb console`) binds to `127.0.0.1` on your machine; the verification token and your AWS credentials stay in the local server process and never reach the browser.

The hosted console — the one `console_ingress` exposes — adds a separate authentication boundary in front of the same design: **Google login** (via an oauth2-proxy in front of the console) decides who gets in, and the token still never leaves the server side. Network exposure (80/443 to the world) and application access (your Google allowlist) are therefore independent controls. See [Console](/guides/console/) for setup and the login flow.

## Summary of trust boundaries

| Secret / surface | Lives in | Readable by |
|---|---|---|
| Source database URL | Secrets Manager (your secret) | Engine host instance role only |
| Verification token | SSM SecureString `<prefix>/verification-token` (never in TF state) | Host at boot; principals with the client policy |
| Clone passwords | Nowhere — derived `sha256(token:branch)[:32]` | Anyone who can read the token |
| Host admin | SSM Session Manager | Principals IAM allows; no SSH exists |
| DBLab API / clone ports | Host-only, zero SG ingress by default | SSM port-forwards (IAM-gated), or opt-in VPC allowlists |
| Hosted console | 80/443 behind Caddy (opt-in) | Google-authenticated users |
