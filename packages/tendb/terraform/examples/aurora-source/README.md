# aurora-source — streaming sync into tendb (Option B)

A minimal Aurora Serverless v2 Postgres cluster that plays the customer's
production database and **streams every change into the tendb engine**
via logical replication — the implementation plan's Option B, rehearsed at
toy scale. The pipeline the console shows:

```
Aurora ──logical replication · seconds──▶ sync-target Postgres (engine host :5433,
                                             │ datadir ON the ZFS pool)
                                             │ zfs snapshot — O(1), seconds at ANY size
                                             ▼
                                        pool snapshots ──▶ branches (as-of-now via --fresh)
```

Snapshots are programmable: `tendb snapshots create` / `snapshots config`
(schedule + retention, also editable in the console), `branches create --fresh`
and `migrate --fresh` snapshot first so the branch is *main as of now*. The
engine host runs `tendb-snapshotd`, driven by two SSM parameters under
`<prefix>/snapshots/` — there is no dump/restore cycle anymore
(`streaming_snapshots = true` on the engine module renders that config).

Aurora is the **publisher**; the subscriber is a small Postgres 18 container
**on the engine host itself** (the "sync target") that the engine's
dump/restore/snapshot cycle then reads locally. Aurora's storage engine
permits no physical exit, so logical is the only streaming option — which is
exactly why this rehearsal matters. No external database sits in the loop.

## Deploy

```bash
terraform init
terraform apply \
  -var 'client_cidrs=["<engine-host-public-ip>/32","<hosted-console-eip>/32"]' \
  -var 'admin_cidrs=["<your-ip>/32"]'
```

Small on purpose: Serverless v2 min 0 / max 1 ACU, one writer, default VPC.
**Cost:** the active replication slot holds a connection, so the cluster will
not auto-pause — budget ~0.5 ACU continuous (≈ $45/mo ceiling at 1 ACU).
`terraform destroy` when done.

The stack also attaches one ingress rule to the **engine's** SG (TCP 5433
from the engine VPC CIDR) so the hosted console can probe the sync target;
the rule is removed with this stack. The engine host's public IP is not an
EIP — re-apply `client_cidrs` if the engine instance is ever stop/started.

## Wire up (in this order)

```bash
ENDPOINT=$(terraform output -raw endpoint)
AURORA_URL="postgres://postgres:<master-pw>@$ENDPOINT:5432/tendb?sslmode=require"

# 0. One-time: seed Aurora itself from whatever the legacy source was
FROM_URL=<legacy-source-url> TO_URL=$AURORA_URL ./sql/seed.sh

# 1. Publication + replication role on Aurora
psql "$AURORA_URL" -v repl_password="'<repl-pw>'" -f sql/publisher.sql

# 2. On the ENGINE HOST (via SSM session/commands):
#    - run the sync target:  docker run -d --name tendb-sync --restart always \
#        -p 5433:5432 -v /var/lib/tendb-sync:/var/lib/postgresql \
#        -e POSTGRES_PASSWORD=<sync-pw> -e POSTGRES_DB=tendb postgres:18
#    - seed it:              FROM_URL=$AURORA_URL TO_URL=<sync-url> ./sql/seed.sh
#    - subscribe it:         psql <sync-url> -v aurora_conn="'...'" -f sql/subscriber.sql

# 3. Tell the console where the subscriber lives (publisher-url is already
#    published by terraform under the same prefix). No sslmode — plain in-VPC TCP.
aws ssm put-parameter --name /tendb/replication/subscriber-url \
  --type SecureString --value "postgres://postgres:<sync-pw>@<engine-private-ip>:5433/tendb" \
  --region eu-north-1

# 4. Repoint the engine's dump source at the sync target: update the source
#    secret (read at boot) AND patch the live server.yml + docker restart
#    dblab_server. Future refreshes dump locally.

# 5. Watch it move
AURORA_URL=$AURORA_URL ./sql/loadgen.sh
```

The console picks the URLs up automatically (SSM for `tendb console`
locally — it tunnels to the sync target over SSM; the hosted console fetches
env at service start and dials in-VPC) and shows the pipeline on the
Dashboard + a detail card on Snapshots.

## TLS

The console verifies TLS strictly. RDS chains to the RDS CA, so give Node the
bundle for the Aurora probe:

```bash
curl -sO https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
export NODE_EXTRA_CA_CERTS=$PWD/global-bundle.pem   # then run `tendb console`
```

The hosted console module does this at boot automatically. The sync-target
hop is plain TCP inside the VPC (no `sslmode` in its URL).

## Caveats

- **DDL does not replicate.** Schema changes must be applied on Aurora AND the
  sync target (Aurora first, then the sync target, then resume writes).
- `copy_data=false` is only correct because the sync target was seeded from
  Aurora and nothing wrote to Aurora before the subscription existed.
  Breaking that ordering silently loses rows.
- DLE single-pool full refresh skips while clones exist — the snapshot leg
  advances on the nightly window (or after freeing clones), while the
  streaming leg stays seconds-behind regardless.
