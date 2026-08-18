# tendb-snapshotd for the local platform: runs the daemon with the local shim
# against the docker host's zfs pool and engine container. Needs --privileged
# plus /dev/zfs, the docker socket, and the state dir mounted (the terraform
# local module wires all of that).
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
      zfsutils-linux docker.io postgresql-client jq curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY tendb-snapshotd.sh /usr/local/bin/tendb-snapshotd
COPY shims/local.sh /etc/tendb/platform-shim.sh
RUN chmod 0755 /usr/local/bin/tendb-snapshotd

ENV TENDB_PARAMS_FILE=/state/params.json
ENTRYPOINT ["/usr/local/bin/tendb-snapshotd"]
