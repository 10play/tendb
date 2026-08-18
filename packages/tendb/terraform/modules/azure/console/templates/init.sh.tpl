#!/usr/bin/env bash
# tendb console host bootstrap (azure). Logs to /var/log/tendb-console-init.log.
# Package releases do NOT replace the instance: tendb-console-updater polls
# the package blob's ETag and reinstalls in-place (~20s), so terraform
# replaces this host only for real infra changes (roles, env template, size).
# Stack: Caddy :80/:443 (auto-HTTPS) -> oauth2-proxy :4180 (Google, domain
# allow-list) -> tendb console :${console_port} (loopback only).
set -euxo pipefail
exec > /var/log/tendb-console-init.log 2>&1

export DEBIAN_FRONTEND=noninteractive
for attempt in $(seq 1 30); do
  apt-get update && apt-get install -y ca-certificates curl gnupg jq \
    debian-keyring debian-archive-keyring apt-transport-https && break
  echo "apt busy (attempt $attempt) — retrying"
  sleep 10
done

# Platform shim: Key Vault over REST with the VM's managed identity — the
# same single-source azure.sh the engine installs, vault + prefix baked in.
mkdir -p /etc/tendb
cat > /etc/tendb/platform-shim.sh <<'SHIM'
export TENDB_AZURE_VAULT="${vault_name}"
export TENDB_PARAM_PREFIX="${engine_param_prefix}"
${shim_body}
SHIM
chmod 0644 /etc/tendb/platform-shim.sh

# az CLI: the console's Node process writes runtime params (snapshot
# schedule, alert webhook, schema config) through the tendb azure adapter,
# which shells out to az — boot-time reads use the shim above instead.
curl -sL https://aka.ms/InstallAzureCLIDeb | bash
for attempt in $(seq 1 12); do
  az login --identity --allow-no-subscriptions && break
  echo "MSI not ready (attempt $attempt) — retrying"
  sleep 10
done

# Node 22 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Caddy (official apt repo)
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  > /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy

# oauth2-proxy (single Go binary)
curl -sSL -o /tmp/o2p.tgz \
  "https://github.com/oauth2-proxy/oauth2-proxy/releases/download/v${oauth2_proxy_version}/oauth2-proxy-v${oauth2_proxy_version}.linux-amd64.tar.gz"
tar -xzf /tmp/o2p.tgz -C /tmp
install -m 0755 "/tmp/oauth2-proxy-v${oauth2_proxy_version}.linux-amd64/oauth2-proxy" /usr/local/bin/oauth2-proxy

# The tendb package
%{ if pkg_blob_url != "" ~}
mkdir -p /var/lib/tendb-console
# MSI-token blob download — no SDK, no account key: Bearer token for the
# storage resource + the mandatory x-ms-version header.
storage_token() {
  curl -s -H "Metadata: true" \
    "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fstorage.azure.com%2F" \
    | jq -r .access_token
}
curl -sf -D /tmp/tendb-pkg-headers \
  -H "Authorization: Bearer $(storage_token)" -H "x-ms-version: 2021-08-06" \
  "${pkg_blob_url}" -o /tmp/tendb.tgz
npm install -g /tmp/tendb.tgz
tr -d '\r' < /tmp/tendb-pkg-headers \
  | awk -F': ' 'tolower($1)=="etag" {print $2}' \
  > /var/lib/tendb-console/installed-etag || true

# In-place release channel: a new blob reinstalls + restarts the console in
# ~20s — no instance replacement, no cert churn, no terraform.
cat > /usr/local/bin/tendb-console-updater.sh <<'UPDATER'
#!/usr/bin/env bash
set -u
URL="${pkg_blob_url}"
MARKER=/var/lib/tendb-console/installed-etag
storage_token() {
  curl -s -H "Metadata: true" \
    "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fstorage.azure.com%2F" \
    | jq -r .access_token
}
blob_etag() {
  curl -sfI -H "Authorization: Bearer $(storage_token)" -H "x-ms-version: 2021-08-06" "$URL" \
    | tr -d '\r' | awk -F': ' 'tolower($1)=="etag" {print $2}'
}
while true; do
  ETAG=$(blob_etag || echo "")
  LAST=$(cat "$MARKER" 2>/dev/null || echo "")
  if [ -n "$ETAG" ] && [ "$ETAG" != "$LAST" ]; then
    echo "[$(date -u +%FT%TZ)] new package $ETAG — installing"
    if curl -sf -H "Authorization: Bearer $(storage_token)" -H "x-ms-version: 2021-08-06" \
        "$URL" -o /tmp/tendb-update.tgz && npm install -g /tmp/tendb-update.tgz; then
      echo "$ETAG" > "$MARKER"
      systemctl restart tendb-console
      echo "[$(date -u +%FT%TZ)] release installed, console restarted"
    else
      echo "[$(date -u +%FT%TZ)] install failed — will retry"
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
systemctl daemon-reload
systemctl enable --now tendb-console-updater
%{ else ~}
npm install -g "${npm_package_spec}"
%{ endif ~}

# ---------------------------------------------------------------------------
# Credentials — pulled via the managed identity, kept out of the trace log.
# /etc/tendb/env is re-generated on every service start, so a token rotation
# only needs `systemctl restart tendb-console`.
# ---------------------------------------------------------------------------
cat > /usr/local/bin/tendb-console-env.sh <<'FETCH'
#!/usr/bin/env bash
set -euo pipefail
source /etc/tendb/platform-shim.sh
opt_param() { pf_get_param "$1" 2>/dev/null || true; }
ENGINE_HOST=$(pf_get_param host)
TOKEN=$(pf_get_param verification-token)
DBNAME=$(pf_get_param dbname)
# Optional upstream-replication endpoints. Absent params leave the vars empty
# and the console reports the feature unconfigured.
REPL_PUB=$(opt_param replication/publisher-url)
REPL_SUB=$(opt_param replication/subscriber-url)
OAUTH_JSON=$(pf_get_secret "${oauth_secret_name}")
umask 077
{
  echo "TENDB_API_URL=http://$ENGINE_HOST:2345"
  echo "TENDB_TOKEN=$TOKEN"
  echo "TENDB_DATABASE=$DBNAME"
  # Platform + vault + prefix let the console reach Key Vault directly
  # (snapshot schedule, on-demand requests) — its DBLab transport is direct.
  echo "TENDB_PLATFORM=azure"
  echo "TENDB_AZURE_VAULT=$TENDB_AZURE_VAULT"
  echo "TENDB_PARAM_PREFIX=$TENDB_PARAM_PREFIX"
  # Quoted: connection URLs can carry & in their query strings.
  if [ -n "$REPL_PUB" ]; then echo "TENDB_REPLICATION_PUBLISHER_URL='$REPL_PUB'"; fi
  if [ -n "$REPL_SUB" ]; then echo "TENDB_REPLICATION_SUBSCRIBER_URL='$REPL_SUB'"; fi
  echo "OAUTH2_PROXY_CLIENT_ID=$(jq -r .client_id <<<"$OAUTH_JSON")"
  echo "OAUTH2_PROXY_CLIENT_SECRET=$(jq -r .client_secret <<<"$OAUTH_JSON")"
} > /etc/tendb/env
# Cookie secret survives restarts, dies with the instance (sessions re-auth).
if [ ! -f /etc/tendb/cookie-secret ]; then
  head -c 32 /dev/urandom | base64 | tr -- '+/' '-_' > /etc/tendb/cookie-secret
fi
echo "OAUTH2_PROXY_COOKIE_SECRET=$(cat /etc/tendb/cookie-secret)" >> /etc/tendb/env
FETCH
chmod 0755 /usr/local/bin/tendb-console-env.sh

# ---------------------------------------------------------------------------
# systemd units. NOTE: EnvironmentFile= is read BEFORE ExecStartPre runs, so
# the fetch-then-source happens inside run wrappers instead — each (re)start
# gets fresh credentials.
# ---------------------------------------------------------------------------
cat > /usr/local/bin/tendb-console-run.sh <<'RUN'
#!/usr/bin/env bash
set -euo pipefail
/usr/local/bin/tendb-console-env.sh
set -a; . /etc/tendb/env; set +a
exec /usr/bin/tendb console --no-open --port ${console_port}
RUN
chmod 0755 /usr/local/bin/tendb-console-run.sh

cat > /usr/local/bin/oauth2-proxy-run.sh <<RUN
#!/usr/bin/env bash
set -euo pipefail
set -a; . /etc/tendb/env; set +a
exec /usr/local/bin/oauth2-proxy \
  --provider=google \
  --http-address=127.0.0.1:4180 \
  --redirect-url=https://${domain}/oauth2/callback \
  --upstream=http://127.0.0.1:${console_port} \
%{ for d in allowed_email_domains ~}
  --email-domain=${d} \
%{ endfor ~}
  --skip-provider-button=true \
  --reverse-proxy=true \
  --cookie-secure=true \
  --cookie-expire=12h \
  --cookie-refresh=1h
RUN
chmod 0755 /usr/local/bin/oauth2-proxy-run.sh

cat > /etc/systemd/system/tendb-console.service <<UNIT
[Unit]
Description=tendb console (loopback)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/tendb-console-run.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/oauth2-proxy.service <<UNIT
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
  email ${acme_email}
}

${domain} {
  reverse_proxy 127.0.0.1:4180
}
CADDY

systemctl daemon-reload
systemctl enable --now tendb-console oauth2-proxy
systemctl restart caddy

echo "tendb-console-init complete"
