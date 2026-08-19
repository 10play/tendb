#!/usr/bin/env bash
# tendb-snapshotd — the on-host executor behind `tendb snapshots create` and
# `tendb schema sync`. Polls the engine-contract param namespace (see
# terraform/docs/ENGINE-CONTRACT.md) through the platform shim and:
#
#   snapshots/request      nonce change  → CHECKPOINT sync target, O(1) zfs
#                                          snapshot, engine rescan restart
#   snapshots/config       {intervalMinutes,retain} → scheduled snapshots +
#                                          retention pruning
#   schema/sync-request    nonce change  → full schema reconcile (missing
#                                          tables created, orphans dropped,
#                                          publication refreshed)
#   schema/config          {autoSync}    → additive-only heal every ~minute
#
# The CLI waits ~10 s for a fresh `@snapshot_*` id after writing a request
# nonce (cli/src/snapshots.ts) — keep the poll tick and snapshot naming
# stable. Requires: zfs, docker, psql, jq, and /etc/tendb/platform-shim.sh.
set -uo pipefail

# shellcheck source=/dev/null
source /etc/tendb/platform-shim.sh
[ -f /etc/tendb/snapshotd.env ] && source /etc/tendb/snapshotd.env

STATE_DIR="${TENDB_STATE_DIR:-/var/lib/tendb}"
POLL_SECONDS="${POLL_SECONDS:-5}"
AUTOSYNC_SECONDS="${AUTOSYNC_SECONDS:-60}"
POOL="${TENDB_ZPOOL:-dblab_pool}"
ENGINE_CONTAINER="${TENDB_ENGINE_CONTAINER:-dblab_server}"

mkdir -p "$STATE_DIR"
SYNC_ERROR="" # last sync_schema failure, "" = success (set -u safety)
log() { echo "[tendb-snapshotd] $(date -u +%FT%TZ) $*"; }

param() { pf_get_param "$1" 2>/dev/null || true; }

subscriber_url() { param replication/subscriber-url; }
publisher_url() { param replication/publisher-url; }

take_snapshot() {
  local sub
  sub=$(subscriber_url)
  if [ -n "$sub" ]; then
    # Flush the sync target so the snapshot is crash-consistent at "now".
    psql "$sub" -Atc "CHECKPOINT" >/dev/null 2>&1 || log "warn: CHECKPOINT failed (continuing)"
  fi
  local name
  name="$POOL@snapshot_$(date -u +%Y%m%d%H%M%S)"
  if zfs snapshot "$name"; then
    log "created $name"
    # The engine only lists pool snapshots after a rescan; a restart (~2 s) is
    # the reliable trigger on DLE 4.1.x.
    docker restart "$ENGINE_CONTAINER" >/dev/null 2>&1 || log "warn: engine restart failed"
    date -u +%s > "$STATE_DIR/last-snapshot-at"
  else
    log "error: zfs snapshot failed"
  fi
}

prune_snapshots() {
  local retain="$1"
  [ "$retain" -ge 1 ] 2>/dev/null || return 0
  # Oldest first; keep the newest $retain. Destroy fails on snapshots with
  # dependent clones/branches — exactly the guard we want, so errors are soft.
  zfs list -H -t snapshot -o name -s creation 2>/dev/null \
    | grep "^$POOL@snapshot_" \
    | head -n -"$retain" \
    | while read -r snap; do
        if zfs destroy "$snap" 2>/dev/null; then
          log "pruned $snap"
        fi
      done
}

# ---- schema reconcile ------------------------------------------------------

list_tables() { # $1=url → quoted "schema.table" lines (public-ish app schemas only)
  # quote_ident so mixed-case names (Prisma's "Coupon") survive the round-trip
  # into pg_dump -t patterns and DROP statements, which down-case bare names.
  psql "$1" -Atc "SELECT quote_ident(schemaname) || '.' || quote_ident(tablename) FROM pg_tables
                  WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
                  ORDER BY 1"
}

refresh_subscription() {
  local sub="$1" name
  name=$(psql "$sub" -Atc "SELECT subname FROM pg_subscription LIMIT 1" 2>/dev/null)
  [ -n "$name" ] || return 0
  # Errors if any published relation is still absent downstream — that means
  # a create above failed and the stream is still stalled, so say so.
  psql "$sub" -Atc "ALTER SUBSCRIPTION \"$name\" REFRESH PUBLICATION" >/dev/null \
    || { log "warn: REFRESH PUBLICATION failed (stream still stalled?)"; return 1; }
}

sync_schema() { # $1 = "additive" | "full" — sets SYNC_ERROR ("" = success)
  local mode="$1" pub sub
  SYNC_ERROR=""
  pub=$(publisher_url); sub=$(subscriber_url)
  [ -n "$pub" ] && [ -n "$sub" ] || {
    log "schema sync skipped (replication URLs not configured)"
    SYNC_ERROR="replication URLs not configured"
    return 1
  }

  local pub_tables sub_tables missing orphaned
  pub_tables=$(list_tables "$pub") || { SYNC_ERROR="cannot reach the publisher from snapshotd"; return 1; }
  sub_tables=$(list_tables "$sub") || { SYNC_ERROR="cannot reach the sync target from snapshotd"; return 1; }
  missing=$(comm -23 <(echo "$pub_tables") <(echo "$sub_tables"))
  orphaned=$(comm -13 <(echo "$pub_tables") <(echo "$sub_tables"))

  if [ -n "$missing" ]; then
    log "creating missing tables: $(echo "$missing" | tr '\n' ' ')"
    # Schema only — logical replication back-fills rows after the refresh.
    # stderr stays on the daemon's log: a silent create failure leaves the
    # stream stalled with WAL piling up on the publisher.
    echo "$missing" | while read -r t; do
      [ -n "$t" ] && pg_dump "$pub" --schema-only --no-owner --no-privileges -t "$t"
    done | psql "$sub" >/dev/null || {
      log "warn: some missing tables failed to create"
      SYNC_ERROR="some missing tables failed to create (see snapshotd logs)"
    }
  fi

  if [ "$mode" = "full" ] && [ -n "$orphaned" ]; then
    log "dropping orphaned tables: $(echo "$orphaned" | tr '\n' ' ')"
    echo "$orphaned" | while read -r t; do
      [ -n "$t" ] && psql "$sub" -Atc "DROP TABLE IF EXISTS $t CASCADE" >/dev/null
    done
  fi

  if [ -n "$missing" ] || { [ "$mode" = "full" ] && [ -n "$orphaned" ]; }; then
    refresh_subscription "$sub" \
      || SYNC_ERROR="${SYNC_ERROR:-REFRESH PUBLICATION failed (see snapshotd logs)}"
  fi
  [ -z "$SYNC_ERROR" ]
}

report_sync_result() { # $1=nonce $2=error ("" = success) → schema/sync-result
  pf_put_param schema/sync-result \
    "$(jq -nc --arg nonce "$1" --arg error "$2" \
        'if $error == "" then {nonce: $nonce, ok: true} else {nonce: $nonce, ok: false, error: $error} end')" \
    || log "warn: could not write schema/sync-result"
}

# ---- main loop -------------------------------------------------------------

nonce_changed() { # $1=param leaf, $2=state file → 0 when a new nonce appeared
  local current previous
  current=$(param "$1")
  [ -n "$current" ] || return 1
  previous=$(cat "$STATE_DIR/$2" 2>/dev/null || true)
  [ "$current" = "$previous" ] && return 1
  echo "$current" > "$STATE_DIR/$2"
  return 0
}

log "starting (prefix=${TENDB_PARAM_PREFIX:-/tendb}, pool=$POOL, poll=${POLL_SECONDS}s)"
# Seed nonce state so a request from a previous life isn't replayed on boot.
param snapshots/request > "$STATE_DIR/last-request" 2>/dev/null || true
param schema/sync-request > "$STATE_DIR/last-sync-request" 2>/dev/null || true

last_autosync=0
while true; do
  if nonce_changed snapshots/request last-request; then
    log "snapshot requested"
    take_snapshot
  fi

  if nonce_changed schema/sync-request last-sync-request; then
    log "full schema sync requested"
    sync_schema full
    # Always answer the nonce — the CLI fails fast on {ok:false} instead of
    # polling drift until its timeout.
    report_sync_result "$(cat "$STATE_DIR/last-sync-request")" "$SYNC_ERROR"
  fi

  config=$(param snapshots/config)
  if [ -n "$config" ]; then
    interval=$(echo "$config" | jq -r '.intervalMinutes // 0' 2>/dev/null || echo 0)
    retain=$(echo "$config" | jq -r '.retain // 0' 2>/dev/null || echo 0)
    if [ "$interval" -gt 0 ] 2>/dev/null; then
      last=$(cat "$STATE_DIR/last-snapshot-at" 2>/dev/null || echo 0)
      now=$(date -u +%s)
      if [ $((now - last)) -ge $((interval * 60)) ]; then
        log "scheduled snapshot (every ${interval}m)"
        take_snapshot
      fi
    fi
    [ "$retain" -ge 1 ] 2>/dev/null && prune_snapshots "$retain"
  fi

  now=$(date -u +%s)
  if [ $((now - last_autosync)) -ge "$AUTOSYNC_SECONDS" ]; then
    last_autosync=$now
    autosync=$(param schema/config | jq -r '.autoSync // false' 2>/dev/null || echo false)
    [ "$autosync" = "true" ] && sync_schema additive
  fi

  sleep "$POLL_SECONDS"
done
