# DBLab host bootstrap — portable core. A platform shim (pf_* functions) is
# prepended by the engine module; see terraform/docs/ENGINE-CONTRACT.md.
# Everything logs to /var/log/dblab-init.log — first stop when smoke tests
# fail. Bare $VARS are shell — templatefile only interpolates the brace form.
set -euxo pipefail
exec > /var/log/dblab-init.log 2>&1

export DEBIAN_FRONTEND=noninteractive
# Ubuntu's unattended-upgrades may hold the apt lock right after boot.
for attempt in $(seq 1 30); do
  apt-get update && apt-get install -y docker.io zfsutils-linux jq python3 unzip curl postgresql-client && break
  echo "apt busy (attempt $attempt) — retrying"
  sleep 10
done
command -v docker >/dev/null || { echo "apt install never succeeded"; exit 1; }
systemctl enable --now docker

# The blank data disk is the ZFS pool device; the shim knows where the
# platform attaches it. Wait out the attach.
DEV=""
for attempt in $(seq 1 30); do
  DEV=$(pf_data_device || true)
  [ -n "$DEV" ] && [ -e "$DEV" ] && break
  DEV=""
  sleep 5
done
[ -n "$DEV" ] || { echo "error: data disk never appeared"; exit 1; }

zpool create -f dblab_pool -O compression=lz4 -O atime=off \
  -m /var/lib/dblab/dblab_pool "$DEV"
# dataSubDir must exist before the engine starts; the dump shares the pool.
mkdir -p /var/lib/dblab/dblab_pool/data /var/lib/dblab/dblab_pool/dump

# Credentials are pulled HERE, via the platform machine identity — they never
# transit user-data, Terraform values, or CI. set +x: keep them out of the log.
set +x
TOKEN=$(pf_get_param verification-token)
SOURCE_URL=$(pf_get_secret "${source_secret_id}")
%{ if source_secret_json_key != "" ~}
SOURCE_URL=$(printf '%s' "$SOURCE_URL" | jq -r '.["${source_secret_json_key}"]')
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
pf_put_param dbname "$DB_NAME"

PRIVATE_IP=$(pf_self_ip)

mkdir -p /root/.dblab/engine/configs /root/.dblab/engine/meta /root/.dblab/engine/logs

# Structure follows upstream config.example.logical_generic.yml (v4.1.x);
# body rendered from modules/common/engine-init/templates/server-yml.tpl.
cat > /root/.dblab/engine/configs/server.yml <<EOF
${server_yml}
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

# tendb-snapshotd: the on-host executor behind `tendb snapshots create` and
# `tendb schema sync` (see packages/tendb/snapshotd). The platform shim it
# sources is the same pf_* set used above.
mkdir -p /etc/tendb /var/lib/tendb
printf '%s' "${shim_script_b64}" | base64 -d > /etc/tendb/platform-shim.sh
chmod 0644 /etc/tendb/platform-shim.sh
printf '%s' "${snapshotd_script_b64}" | base64 -d > /usr/local/bin/tendb-snapshotd
chmod 0755 /usr/local/bin/tendb-snapshotd
printf '%s' "${snapshotd_unit_b64}" | base64 -d > /etc/systemd/system/tendb-snapshotd.service
cat > /etc/tendb/snapshotd.env <<EOF
TENDB_PARAM_PREFIX=${param_prefix}
EOF
systemctl daemon-reload
systemctl enable --now tendb-snapshotd

echo "dblab-init complete"
