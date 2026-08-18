#!/usr/bin/env bash
# tendb local preflight — the part terraform cannot do: a ZFS-capable docker
# host. Idempotent; run it again any time.
#
#   macOS:  creates/starts a colima VM (vz + Rosetta for the amd64 DBLab
#           images), installs zfsutils inside it, and builds a file-backed
#           zpool `dblab_pool` mounted at /var/lib/dblab/dblab_pool.
#   Linux:  same steps natively (needs sudo).
#
# Docker Desktop will NOT work on macOS: its LinuxKit kernel has no ZFS.
set -euo pipefail

POOL_NAME="${TENDB_ZPOOL:-dblab_pool}"
POOL_SIZE="${TENDB_POOL_SIZE:-20G}"
POOL_IMG="/var/lib/tendb/pool.img"
MOUNT_DIR="/var/lib/dblab/${POOL_NAME}"
COLIMA_PROFILE="${TENDB_COLIMA_PROFILE:-default}"
COLIMA_ARGS=(--cpu "${TENDB_VM_CPUS:-4}" --memory "${TENDB_VM_MEMORY:-8}" --disk "${TENDB_VM_DISK:-60}" --vm-type vz --vz-rosetta)

in_vm() { colima ssh -p "$COLIMA_PROFILE" -- sudo bash -c "$1"; }

setup_pool() { # $1 = runner ("in_vm" or "sudo bash -c")
  local run="$1"
  $run "command -v zpool >/dev/null || { export DEBIAN_FRONTEND=noninteractive; apt-get update -q && apt-get install -y -q zfsutils-linux; }"
  $run "modprobe zfs"
  if $run "zpool list $POOL_NAME >/dev/null 2>&1"; then
    echo "zpool $POOL_NAME already exists"
  elif $run "[ -f $POOL_IMG ]"; then
    # VM restarted: the loop device is gone but the pool image survives.
    echo "re-importing $POOL_NAME from $POOL_IMG"
    $run "LOOP=\$(losetup --show -f $POOL_IMG) && zpool import -d \$LOOP $POOL_NAME"
  else
    $run "mkdir -p \$(dirname $POOL_IMG) && truncate -s $POOL_SIZE $POOL_IMG"
    $run "zpool create -f $POOL_NAME -O compression=lz4 -O atime=off -m $MOUNT_DIR \$(losetup --show -f $POOL_IMG)"
  fi
  $run "mkdir -p $MOUNT_DIR/data $MOUNT_DIR/dump /var/lib/dblab"
  $run "zpool list $POOL_NAME"
}

case "$(uname -s)" in
  Darwin)
    command -v brew >/dev/null || { echo "error: homebrew required (https://brew.sh)"; exit 1; }
    if ! command -v colima >/dev/null; then
      echo "installing colima…"
      brew install colima
    fi
    if ! colima status -p "$COLIMA_PROFILE" >/dev/null 2>&1; then
      echo "starting colima (${COLIMA_ARGS[*]})…"
      colima start -p "$COLIMA_PROFILE" "${COLIMA_ARGS[@]}"
    else
      echo "colima already running"
    fi
    setup_pool in_vm
    SOCKET="unix://$HOME/.colima/${COLIMA_PROFILE}/docker.sock"
    echo
    echo "ready. point terraform/docker at the colima VM:"
    echo "  export DOCKER_HOST=$SOCKET"
    echo "  (or: docker context use colima)"
    ;;
  Linux)
    setup_pool "sudo bash -c"
    echo "ready. docker on this host can run the engine directly."
    ;;
  *)
    echo "unsupported OS: $(uname -s)"; exit 1
    ;;
esac
