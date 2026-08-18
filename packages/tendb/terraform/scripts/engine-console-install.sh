#!/usr/bin/env bash
# Install the tendb console stack ON THE ENGINE HOST (console-on-engine).
#
# Run via SSM (never bake into engine user_data — that template is frozen;
# any rendered-byte change replaces the instance and destroys the ZFS pool):
#   aws s3 cp s3://<pkg-bucket>/migration/engine-console-install.sh - | bash
#
# Prereqs (terraform examples/standalone with console_on_engine = true):
#   - engine SG has 80/443 open (console_ingress)
#   - engine role has the console-on-engine policy (pkg bucket read, oauth
#     secret read, PutParameter on snapshots|alerts|schema)
#   - migration/caddy-state.tgz + migration/cookie-secret uploaded from the
#     old console host (skips new Let's Encrypt issuance — sslip.io shares
#     LE's registered-domain quota globally)
#
# Touches NOTHING else on the host: dblab_server, the sync container, and
# tendb-snapshotd keep running throughout.
set -euxo pipefail
exec > >(tee /var/log/tendb-console-install.log) 2>&1

REGION=eu-north-1
PREFIX=/tendb
DOMAIN=console.51-20-21-248.sslip.io
ACME_EMAIL=amir@10play.dev
EMAIL_DOMAIN=10play.dev
OAUTH_SECRET_ID=tendb/console-oauth
PKG_BUCKET=tendb-pkg-409154939891
PKG_S3_URI="s3://$PKG_BUCKET/tendb.tgz"
CONSOLE_PORT=4400
O2P_VERSION=7.8.1

# --- preflight -------------------------------------------------------------
FREE_GB=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
if [ "$FREE_GB" -lt 3 ]; then
  echo "ABORT: only ${FREE_GB}G free on / (need >=3G)"; exit 1
fi
free -m

# --- memory guardrails (4 GB box shared with the engine) -------------------
# ZFS ARC defaults to half of RAM; cap it at 1 GB so the console + engine
# never fight the page cache for the same memory.
echo 1073741824 > /sys/module/zfs/parameters/zfs_arc_max || true
echo "options zfs zfs_arc_max=1073741824" > /etc/modprobe.d/zfs.conf
# Swap absorbs spikes instead of the OOM killer picking a victim. Root EBS
# only — never on ZFS.
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi

# --- packages --------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
for attempt in $(seq 1 30); do
  apt-get update && apt-get install -y ca-certificates curl gnupg unzip jq \
    debian-keyring debian-archive-keyring apt-transport-https && break
  echo "apt busy (attempt $attempt) — retrying"
  sleep 10
done

# Node 22 (NodeSource)
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# Caddy (official apt repo)
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  > /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
systemctl stop caddy

# oauth2-proxy (single Go binary)
curl -sSL -o /tmp/o2p.tgz \
  "https://github.com/oauth2-proxy/oauth2-proxy/releases/download/v$O2P_VERSION/oauth2-proxy-v$O2P_VERSION.linux-amd64.tar.gz"
tar -xzf /tmp/o2p.tgz -C /tmp
install -m 0755 "/tmp/oauth2-proxy-v$O2P_VERSION.linux-amd64/oauth2-proxy" /usr/local/bin/oauth2-proxy

# --- migrated state: LE cert store + oauth cookie secret -------------------
mkdir -p /etc/tendb
aws s3 cp "s3://$PKG_BUCKET/migration/caddy-state.tgz" /tmp/caddy-state.tgz
tar xzf /tmp/caddy-state.tgz -C /var/lib/caddy
chown -R caddy:caddy /var/lib/caddy
rm /tmp/caddy-state.tgz
aws s3 cp "s3://$PKG_BUCKET/migration/cookie-secret" /etc/tendb/cookie-secret
chmod 600 /etc/tendb/cookie-secret

# --- the tendb package + in-place release updater ------------------------
aws s3 cp "$PKG_S3_URI" /tmp/tendb.tgz
npm install -g /tmp/tendb.tgz
mkdir -p /var/lib/tendb-console
aws s3api head-object --bucket "$PKG_BUCKET" --key tendb.tgz \
  --query ETag --output text > /var/lib/tendb-console/installed-etag || true

cat > /usr/local/bin/tendb-console-updater.sh <<UPDATER
#!/usr/bin/env bash
set -u
URI="$PKG_S3_URI"
BUCKET="$PKG_BUCKET"
KEY=tendb.tgz
MARKER=/var/lib/tendb-console/installed-etag
while true; do
  ETAG=\$(aws s3api head-object --bucket "\$BUCKET" --key "\$KEY" --query ETag --output text 2>/dev/null || echo "")
  LAST=\$(cat "\$MARKER" 2>/dev/null || echo "")
  if [ -n "\$ETAG" ] && [ "\$ETAG" != "\$LAST" ]; then
    echo "[\$(date -u +%FT%TZ)] new package \$ETAG — installing"
    if aws s3 cp "\$URI" /tmp/tendb-update.tgz && npm install -g /tmp/tendb-update.tgz; then
      echo "\$ETAG" > "\$MARKER"
      systemctl restart tendb-console
      echo "[\$(date -u +%FT%TZ)] release installed, console restarted"
    else
      echo "[\$(date -u +%FT%TZ)] install failed — will retry"
      sleep 30
    fi
  fi
  sleep 15
done
UPDATER
chmod 0755 /usr/local/bin/tendb-console-updater.sh

cat > /etc/systemd/system/tendb-console-updater.service <<'UNIT'
[Unit]
Description=tendb console in-place release updater
After=network-online.target

[Service]
ExecStart=/usr/local/bin/tendb-console-updater.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT

# --- env fetch + run wrappers ----------------------------------------------
curl -fsSL --max-time 30 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  -o /etc/tendb/rds-global-bundle.pem || rm -f /etc/tendb/rds-global-bundle.pem

cat > /usr/local/bin/tendb-console-env.sh <<FETCH
#!/usr/bin/env bash
set -euo pipefail
REGION="$REGION"
PREFIX="$PREFIX"
param() {
  aws ssm get-parameter --region "\$REGION" --name "\$PREFIX/\$1" \${2:-} \
    --query Parameter.Value --output text
}
ENGINE_HOST=\$(param host)
TOKEN=\$(param verification-token --with-decryption)
DBNAME=\$(param dbname)
REPL_PUB=\$(param replication/publisher-url --with-decryption 2>/dev/null || true)
REPL_SUB=\$(param replication/subscriber-url --with-decryption 2>/dev/null || true)
OAUTH_JSON=\$(aws secretsmanager get-secret-value --region "\$REGION" \
  --secret-id "$OAUTH_SECRET_ID" --query SecretString --output text)
umask 077
{
  echo "TENDB_API_URL=http://\$ENGINE_HOST:2345"
  echo "TENDB_TOKEN=\$TOKEN"
  echo "TENDB_DATABASE=\$DBNAME"
  echo "TENDB_REGION=\$REGION"
  echo "TENDB_SSM_PREFIX=\$PREFIX"
  # Persist the alert feed + seen-findings map across restarts/releases.
  echo "TENDB_STATE_DIR=/var/lib/tendb-console"
  if [ -n "\$REPL_PUB" ]; then echo "TENDB_REPLICATION_PUBLISHER_URL='\$REPL_PUB'"; fi
  if [ -n "\$REPL_SUB" ]; then echo "TENDB_REPLICATION_SUBSCRIBER_URL='\$REPL_SUB'"; fi
  if [ -f /etc/tendb/rds-global-bundle.pem ]; then
    echo "NODE_EXTRA_CA_CERTS=/etc/tendb/rds-global-bundle.pem"
  fi
  echo "OAUTH2_PROXY_CLIENT_ID=\$(jq -r .client_id <<<"\$OAUTH_JSON")"
  echo "OAUTH2_PROXY_CLIENT_SECRET=\$(jq -r .client_secret <<<"\$OAUTH_JSON")"
} > /etc/tendb/env
if [ ! -f /etc/tendb/cookie-secret ]; then
  head -c 32 /dev/urandom | base64 | tr -- '+/' '-_' > /etc/tendb/cookie-secret
fi
echo "OAUTH2_PROXY_COOKIE_SECRET=\$(cat /etc/tendb/cookie-secret)" >> /etc/tendb/env
FETCH
chmod 0755 /usr/local/bin/tendb-console-env.sh

cat > /usr/local/bin/tendb-console-run.sh <<RUN
#!/usr/bin/env bash
set -euo pipefail
/usr/local/bin/tendb-console-env.sh
set -a; . /etc/tendb/env; set +a
exec /usr/bin/tendb console --no-open --port $CONSOLE_PORT
RUN
chmod 0755 /usr/local/bin/tendb-console-run.sh

cat > /usr/local/bin/oauth2-proxy-run.sh <<RUN
#!/usr/bin/env bash
set -euo pipefail
set -a; . /etc/tendb/env; set +a
exec /usr/local/bin/oauth2-proxy \
  --provider=google \
  --http-address=127.0.0.1:4180 \
  --redirect-url=https://$DOMAIN/oauth2/callback \
  --upstream=http://127.0.0.1:$CONSOLE_PORT \
  --email-domain=$EMAIL_DOMAIN \
  --skip-provider-button=true \
  --reverse-proxy=true \
  --cookie-secure=true \
  --cookie-expire=12h \
  --cookie-refresh=1h
RUN
chmod 0755 /usr/local/bin/oauth2-proxy-run.sh

# MemoryMax: if memory ever gets tight on this shared box, the console dies
# and restarts — the engine never does.
cat > /etc/systemd/system/tendb-console.service <<'UNIT'
[Unit]
Description=tendb console (loopback)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/tendb-console-run.sh
Restart=on-failure
RestartSec=5
MemoryHigh=384M
MemoryMax=512M

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/oauth2-proxy.service <<'UNIT'
[Unit]
Description=oauth2-proxy (Google) for tendb console
After=tendb-console.service
Wants=tendb-console.service

[Service]
ExecStart=/usr/local/bin/oauth2-proxy-run.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/caddy/Caddyfile <<CADDY
{
  email $ACME_EMAIL
}

$DOMAIN {
  reverse_proxy 127.0.0.1:4180
}
CADDY

systemctl daemon-reload
systemctl enable --now tendb-console oauth2-proxy tendb-console-updater
systemctl restart caddy

sleep 3
systemctl is-active tendb-console oauth2-proxy caddy tendb-console-updater
echo "engine-console-install complete"
