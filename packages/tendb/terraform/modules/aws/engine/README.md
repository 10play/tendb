# tendb engine module

The DBLab host: one EC2 instance (Ubuntu 24.04 + ZFS on a gp3 volume) running
`dblab-server` in Docker, syncing from a source Postgres by logical
dump/restore, serving thin-clone branch databases on a port pool.

```hcl
module "engine" {
  source = "…/tendb/terraform/modules/engine"

  name      = "tendb"
  vpc_id    = "vpc-…"
  subnet_id = "subnet-…"

  # who may reach 2345 + clone ports over TCP (SSM tunnels work regardless)
  allowed_security_group_ids = [aws_security_group.app_nodes.id]
  # and/or: allowed_cidr_blocks = ["10.60.0.0/16"]

  size                    = "medium"        # small | medium | large | xlarge (+ per-knob overrides)
  postgres_major_version  = 18              # MUST match the source — no default
  source_secret_arn       = "arn:aws:secretsmanager:…:secret:tendb/source-url"
  source_secret_json_key  = null            # or e.g. "DATABASE_URL" for JSON secrets
  dump_exclude_extensions = []              # ["pg_session_jwt"] when the source is Neon

  create_client_iam_policy = true           # attach the output to CI/operator roles
}
```

## Design points

- **No SSH.** IMDSv2-only, Session Manager for everything.
- **Secrets never touch state or user-data.** The host pulls the source URL
  (Secrets Manager) and its token (SSM SecureString) at boot via its instance
  profile. The token itself is generated ephemerally and written with a
  write-only argument (`value_wo`) — that's why `terraform >= 1.11`.
- **Discovery params** under `ssm_prefix` (default `/<name>`): `instance-id`,
  `host`, `verification-token`, `dbname` (host-published at boot), `port-pool`.
  They die with the module — a missing `instance-id` is the "platform is down"
  signal consumers rely on.
- **Client IAM**: `client_iam_policy_json` output grants SSM
  SendCommand/StartSession on the two AWS documents + any instance tagged
  `Role=<ssm_access_tag_value>` (survives instance replacement), session
  housekeeping, and `ssm:GetParameter` on the prefix (the CLI reads the token
  to derive clone passwords).
- **Existing fleets**: set `ssm_prefix` and `ssm_access_tag_value` to match
  what your consumers already use (e.g. `/tendb-poc/dblab` + `dblab`).

## Gotchas encoded in the template (do not "simplify" these away)

- apt retry loop — unattended-upgrades holds the lock right after boot
- non-root-disk search — Nitro renames `/dev/sdf` to `/dev/nvmeXn1`
- `set +x` around credential fetch — keeps secrets out of the init log
- python `urllib.parse` URL splitting — survives URL-encoded passwords
- `cloneAccessAddresses: "0.0.0.0"` — the default is loopback-only
- restore runs `--no-tablespaces --no-privileges --no-owner --exit-on-error`
  and `skipPolicies` — source-managed roles don't exist locally
- `user_data_replace_on_change` — config changes replace the instance and
  destroy all clones (data re-syncs at boot)
