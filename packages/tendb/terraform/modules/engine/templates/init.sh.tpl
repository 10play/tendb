#!/usr/bin/env bash
# DBLab host bootstrap (cloud-init user-data). Everything logs to
# /var/log/dblab-init.log — first stop when smoke tests fail.
#
# Bare $VARS are shell — templatefile only interpolates the brace form.
set -euxo pipefail
exec > /var/log/dblab-init.log 2>&1

export DEBIAN_FRONTEND=noninteractive
# Ubuntu's unattended-upgrades may hold the apt lock right after boot.
for attempt in $(seq 1 30); do
  apt-get update && apt-get install -y docker.io zfsutils-linux jq python3 unzip curl && break
  echo "apt busy (attempt $attempt) — retrying"
  sleep 10
done
command -v docker >/dev/null || { echo "apt install never succeeded"; exit 1; }

# AWS CLI v2 (Ubuntu ships none; snap is slower and flakier in cloud-init).
curl -sSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp
/tmp/aws/install
systemctl enable --now docker

# The blank EBS volume is the ZFS pool device. Terraform says /dev/sdf, but
# Nitro renames to /dev/nvmeXn1 — find the non-root disk, waiting out attach.
ROOT_DISK=$(lsblk -no PKNAME "$(findmnt -no SOURCE /)" | head -1)
DEV=""
for attempt in $(seq 1 30); do
  for d in $(lsblk -dno NAME,TYPE | awk '$2=="disk"{print $1}'); do
    [ "$d" = "$ROOT_DISK" ] && continue
    DEV="/dev/$d"
  done
  [ -n "$DEV" ] && break
  sleep 5
done
[ -n "$DEV" ] || { echo "error: data disk never appeared"; exit 1; }

zpool create -f dblab_pool -O compression=lz4 -O atime=off \
  -m /var/lib/dblab/dblab_pool "$DEV"
# dataSubDir must exist before the engine starts; the dump shares the pool.
mkdir -p /var/lib/dblab/dblab_pool/data /var/lib/dblab/dblab_pool/dump

# Credentials are pulled HERE, via the instance profile — they never transit
# user-data, Terraform values, or CI. set +x: keep them out of the trace log.
set +x
TOKEN=$(aws ssm get-parameter --region "${region}" --name "${token_param}" \
  --with-decryption --query Parameter.Value --output text)
%{ if source_secret_json_key != "" ~}
SOURCE_URL=$(aws secretsmanager get-secret-value --region "${region}" \
  --secret-id "${source_secret_id}" --query SecretString --output text | jq -r '.["${source_secret_json_key}"]')
%{ else ~}
SOURCE_URL=$(aws secretsmanager get-secret-value --region "${region}" \
  --secret-id "${source_secret_id}" --query SecretString --output text)
%{ endif ~}

# urllib.parse, not sed: survives URL-encoded passwords. shlex-quoted for eval.
eval "$(python3 - "$SOURCE_URL" <<'PY'
import shlex, sys, urllib.parse as u
p = u.urlsplit(sys.argv[1])
print("DB_HOST=" + shlex.quote(p.hostname or ""))
print("DB_PORT=" + shlex.quote(str(p.port or 5432)))
print("DB_USER=" + shlex.quote(u.unquote(p.username or "")))
print("DB_PASS=" + shlex.quote(u.unquote(p.password or "")))
print("DB_NAME=" + shlex.quote(p.path.lstrip("/")))
PY
)"

# Clone URIs need the app db's name: keep the on-host file (legacy scripts)
# and publish it for the tendb CLI.
echo "$DB_NAME" > /var/lib/dblab/dbname
aws ssm put-parameter --region "${region}" --name "${dbname_param}" \
  --type String --value "$DB_NAME" --overwrite

IMDS_TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
PRIVATE_IP=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \
  http://169.254.169.254/latest/meta-data/local-ipv4)

mkdir -p /root/.dblab/engine/configs /root/.dblab/engine/meta /root/.dblab/engine/logs

# Structure follows upstream config.example.logical_generic.yml (v4.1.x).
cat > /root/.dblab/engine/configs/server.yml <<EOF
server:
  verificationToken: "$TOKEN"
  port: 2345

# Engine console. Binds to the host's loopback only — reachable exclusively
# via SSM tunnels (tendb ui).
embeddedUI:
  enabled: ${ui_enabled}
  dockerImage: "${ui_image}"
  host: "127.0.0.1"
  port: 2346

global:
  engine: postgres
  debug: false
  database:
    username: postgres
    dbname: postgres

poolManager:
  mountDir: /var/lib/dblab
  dataSubDir: data
  clonesMountSubDir: clones
  socketSubDir: sockets
  observerSubDir: observer
  preSnapshotSuffix: "_pre"
  selectedPool: ""

databaseContainer: &db_container
  dockerImage: "${clone_image}"
  containerConfig:
    "shm-size": ${shm_size}

# Per clone — every clone allocates shared_buffers (see module locals.tf).
databaseConfigs: &db_configs
  configs:
%{ if streaming_snapshots ~}
    # Clones inherit the sync target's subscription; without workers they can
    # never connect out and fight it for the publisher's replication slot.
    max_logical_replication_workers: "0"
%{ endif ~}
%{ for key, value in postgres_configs ~}
    ${key}: "${value}"
%{ endfor ~}

provision:
  <<: *db_container
  portPool:
    from: ${port_pool_from}
    to: ${port_pool_to}
  useSudo: false
  keepUserPasswords: false
  cloneAccessAddresses: "0.0.0.0" # default is loopback-only — clones must be reachable in-VPC

retrieval:
  refresh:
%{ if streaming_snapshots ~}
    timetable: ""
    skipStartRefresh: true
  jobs: # streaming mode: tendb-snapshotd snapshots the live sync target
    - logicalSnapshot
%{ else ~}
    timetable: "${refresh_cron}"
    skipStartRefresh: ${skip_start_refresh}
  jobs:
    - logicalDump
    - logicalRestore
    - logicalSnapshot
%{ endif ~}
  spec:
    logicalDump:
      options:
        <<: *db_container
        dumpLocation: "/var/lib/dblab/dblab_pool/dump"
        source:
          type: remote
          connection: # libpq sslmode defaults to prefer — TLS negotiates when offered
            dbname: $DB_NAME
            host: $DB_HOST
            port: $DB_PORT
            username: $DB_USER
            password: "$DB_PASS"
        databases: # only the app database — managed-Postgres roles can't dump system DBs
          $DB_NAME: {}
        parallelJobs: ${dump_parallel_jobs}
%{ if length(exclude_extensions) > 0 ~}
        customOptions: # provider-proprietary extensions, not installable in stock Postgres
%{ for ext in exclude_extensions ~}
          - "--exclude-extension=${ext}"
%{ endfor ~}
%{ else ~}
        customOptions: []
%{ endif ~}
    logicalRestore:
      options:
        <<: *db_container
        dumpLocation: "/var/lib/dblab/dblab_pool/dump"
        parallelJobs: ${restore_parallel_jobs}
        <<: *db_configs
        queryPreprocessing:
          queryPath: ""
          maxParallelWorkers: 1
          inline: ""
        customOptions: # source-managed roles don't exist locally
          - "--no-tablespaces"
          - "--no-privileges"
          - "--no-owner"
          - "--exit-on-error"
        skipPolicies: true
    logicalSnapshot:
      options:
        <<: *db_configs
        preprocessingScript: ""
        dataPatching:
          <<: *db_container
          queryPreprocessing:
            queryPath: ""
            maxParallelWorkers: 1
            inline: ""

cloning:
  accessHost: "$PRIVATE_IP"
  maxIdleMinutes: ${max_idle_minutes} # leaked-clone reaper; active consumers never idle
  protectionLeaseDurationMinutes: 1440
  protectionMaxDurationMinutes: 10080
  protectionExpiryWarningMinutes: 1440

diagnostic:
  logsRetentionDays: ${logs_retention_days}

platform:
  url: "https://postgres.ai/api/general"
  enableTelemetry: false
EOF
chmod 0600 /root/.dblab/engine/configs/server.yml
set -x

docker run --name dblab_server --label dblab_control --privileged --detach \
  --restart unless-stopped --publish 2345:2345 \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --volume /var/lib/dblab:/var/lib/dblab:rshared \
  --volume /root/.dblab/engine/configs:/home/dblab/configs \
  --volume /root/.dblab/engine/meta:/home/dblab/meta \
  --volume /root/.dblab/engine/logs:/home/dblab/logs \
  "${server_image}"

echo "dblab-init complete"
