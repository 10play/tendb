# tendb console module

Hosts the tendb console (the same server `tendb console` runs locally)
in-VPC next to the engine, behind Google login:

```
browser ──HTTPS──▶ Caddy (:443, auto Let's Encrypt)
                     └─▶ oauth2-proxy (:4180, Google, email-domain allow-list)
                           └─▶ tendb console (:4400, loopback only, direct
                               TCP to the engine — no SSM tunnels needed)
```

The DBLab verification token, clone credentials, and AWS access stay on the
host; the browser only ever sees the authenticated console UI.

## Prerequisites (one-time, manual)

1. **Google OAuth client** — Google Cloud console → APIs & Services →
   Credentials → Create OAuth client ID (Web application). Authorized redirect
   URI: `https://<domain>/oauth2/callback` (also emitted as the
   `oauth_redirect_uri` output). Then:

   ```bash
   aws secretsmanager create-secret --name tendb/console-oauth \
     --secret-string '{"client_id":"…","client_secret":"…"}'
   ```

2. **A domain** — e.g. `dbconsole.10play.dev`. If its zone is in Route53, pass
   `hosted_zone_id` and the A record is managed for you. If DNS lives
   elsewhere, leave it null and create the record shown in the
   `required_dns_record` output; Caddy retries certificate issuance until the
   name resolves.

3. **The package** — `pnpm pack` in `tendb/cli/` and pass the tarball path
   (uploaded to a private S3 bucket, installed on the host at boot). Once the
   package is on npm, pass `npm_package_spec = "@10play/tendb@x.y.z"`
   instead.

## Usage

```hcl
module "console" {
  source = "…/tendb/terraform/modules/console"

  vpc_id    = module.network.vpc_id
  subnet_id = module.network.engine_subnet_id   # must be public

  domain                = "dbconsole.10play.dev"
  hosted_zone_id        = null                  # DNS managed elsewhere
  acme_email            = "amir@10play.dev"
  oauth_secret_arn      = "arn:aws:secretsmanager:…:secret:tendb/console-oauth"
  allowed_email_domains = ["10play.dev"]
  package_tarball_path  = "${path.root}/../../cli/10play-tendb-0.1.0.tgz"
  engine_ssm_prefix     = module.engine.ssm_prefix
}
```

Make sure the engine admits the console: either its subnet is covered by the
engine's `allowed_cidr_blocks` (the standalone example's VPC-CIDR rule does
this) or pass this module's `security_group_id` output into the engine's
`allowed_security_group_ids`.

## Operations

- **Token rotation / engine replacement**: the console caches the engine IP,
  token, and dbname at service start — run
  `systemctl restart tendb-console` (via SSM Session Manager; no SSH) after
  either event.
- **Package upgrade**: re-run `pnpm pack`, `terraform apply` — the tarball
  hash change replaces the instance (sessions re-authenticate, nothing else is
  stateful).
- **Access change**: `allowed_email_domains` is an oauth2-proxy allow-list;
  per-user allow-lists (`--authenticated-emails-file`) are the next step when
  domain-wide is too broad.
- Cost: t3.small + EIP + 16 GB gp3 ≈ **$18/mo**.
