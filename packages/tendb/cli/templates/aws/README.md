# tendb — AWS deployment

Scaffolded by `tendb init`. One EC2 host (Ubuntu 24.04, ZFS on gp3) syncs from
your source Postgres and serves copy-on-write branch databases. No SSH, no
inbound internet — the CLI tunnels over SSM Session Manager.

## Bring it up

1. Create the source secret (the URL must never land in terraform state), then
   put its ARN into `terraform.tfvars` (`source_secret_arn`):

   ```bash
   aws secretsmanager create-secret --name tendb/source-url \
     --secret-string 'postgres://user:pass@host:5432/dbname'
   ```

2. `tendb up` — wraps `terraform init && terraform apply` here and writes the
   discovery outputs into `tendb.json`. (Plain `terraform apply` works too.)

3. Wait for the first sync, then:

   ```bash
   tendb status
   tendb branches create my-feature
   tendb psql my-feature
   ```

Client prereqs: Node ≥ 20, `session-manager-plugin`
(`brew install --cask session-manager-plugin`), and AWS credentials with the
`client_iam_policy_arn` output attached.

## Caveats that cost real money/time

- `postgres_major_version` MUST match the source's major — restore fails otherwise.
- Any change that replaces the instance destroys all clones (data re-syncs at boot).
- Provider-proprietary extensions break restore: `dump_exclude_extensions = ["pg_session_jwt"]` for Neon.
- A data refresh is skipped (non-destructively) while clones exist.

`tendb down` destroys the stack.
