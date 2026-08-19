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
#                                          tables/columns/indexes created,
#                                          orphans dropped, publication
#                                          refreshed; answered on
#                                          schema/sync-result)
#   schema/config          {autoSync}    → additive-only heal every ~minute
#                                          (creates missing tables, columns,
#                                          indexes; never drops)
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
# A live publisher always has WAL past the subscriber's last applied byte, so
# "caught up" is an epsilon, not zero. Scheduled snapshots wait this long for
# the stream to converge before snapshotting a torn state anyway.
CONVERGE_LAG_BYTES="${CONVERGE_LAG_BYTES:-1048576}"
CONVERGE_MAX_WAIT_SECONDS="${CONVERGE_MAX_WAIT_SECONDS:-300}"

mkdir -p "$STATE_DIR"
SYNC_ERROR="" # last sync_schema failure, "" = success (set -u safety)
log() { echo "[tendb-snapshotd] $(date -u +%FT%TZ) $*"; }

param() { pf_get_param "$1" 2>/dev/null || true; }

subscriber_url() { param replication/subscriber-url; }
publisher_url() { param replication/publisher-url; }

# Sequence VALUES never replicate — only rows do. Left alone, every sequence
# on the sync target sits wherever the seed left it (or at 1, for tables the
# schema heal created via `pg_dump --schema-only`, which omits setval) while
# replicated rows carry the publisher's much larger ids. Branches inherit
# that, so the first INSERT on a clone collides with an existing key. Realign
# right before the snapshot: that is the only state branches ever see.
align_sequences() { # $1 = subscriber url
  local sub="$1" stmts
  # Owned sequences via pg_depend: deptype 'a' is serial, 'i' is an identity
  # column — matching on name conventions misses the latter entirely.
  stmts=$(psql "$sub" -Atc "
    SELECT format('SELECT setval(%L, COALESCE((SELECT max(%I) FROM %s), 1), (SELECT max(%I) IS NOT NULL FROM %s));',
                  s.oid::regclass::text, a.attname, t.oid::regclass::text,
                  a.attname, t.oid::regclass::text)
    FROM pg_class s
    JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = s.oid AND d.deptype IN ('a', 'i')
    JOIN pg_class t ON t.oid = d.refobjid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
    JOIN pg_namespace n ON n.oid = s.relnamespace
    WHERE s.relkind = 'S' AND n.nspname NOT IN ('pg_catalog', 'information_schema')" 2>/dev/null)
  [ -n "$stmts" ] || return 0
  echo "$stmts" | psql "$sub" -q >/dev/null || log "warn: sequence alignment failed"
}

# Schema reaches the sync target out-of-band (the heal channel) while the rows
# that go with it — including the migration tool's ledger inserts — arrive on
# the replication stream. Snapshotting while the stream is behind freezes a
# branch that has the new column but not the ledger row saying why, which
# surfaces later as a bogus "column already exists" migration failure.
stream_converged() { # 0 = subscriber has applied ~everything the publisher wrote
  local pub sub sub_lsn lag
  pub=$(publisher_url); sub=$(subscriber_url)
  [ -n "$pub" ] && [ -n "$sub" ] || return 0 # not a streaming deployment

  sub_lsn=$(psql "$sub" -Atc "SELECT latest_end_lsn FROM pg_stat_subscription WHERE relid IS NULL LIMIT 1" 2>/dev/null)
  [ -n "$sub_lsn" ] || return 0 # no subscription — nothing to wait for

  # Apply-error counters are cumulative and never reset, so they cannot gate
  # this; a wedged stream shows up here as lag that keeps growing.
  lag=$(psql "$pub" -Atc "SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), '$sub_lsn')::bigint" 2>/dev/null)
  [ -n "$lag" ] || return 1
  [ "$lag" -le "$CONVERGE_LAG_BYTES" ] 2>/dev/null
}

take_snapshot() { # $1 = "scheduled" to wait for convergence; requests never wait
  local mode="${1:-}" sub converged=yes waiting_since now
  sub=$(subscriber_url)

  if ! stream_converged; then
    converged=no
    now=$(date -u +%s)
    waiting_since=$(cat "$STATE_DIR/converge-waiting-since" 2>/dev/null || true)
    if [ -z "$waiting_since" ]; then
      waiting_since=$now
      echo "$now" > "$STATE_DIR/converge-waiting-since"
      log "stream behind — holding snapshots until it catches up (max ${CONVERGE_MAX_WAIT_SECONDS}s)"
    fi
    # An explicit request must still produce a snapshot: the CLI waits ~10 s
    # for a fresh id after writing the nonce.
    if [ "$mode" = "scheduled" ] && [ $((now - waiting_since)) -lt "$CONVERGE_MAX_WAIT_SECONDS" ]; then
      return 0
    fi
    log "warn: snapshotting an unconverged stream — branches from it may carry healed schema without the rows that explain it"
  fi
  rm -f "$STATE_DIR/converge-waiting-since"

  if [ -n "$sub" ]; then
    align_sequences "$sub"
    # Flush the sync target so the snapshot is crash-consistent at "now".
    psql "$sub" -Atc "CHECKPOINT" >/dev/null 2>&1 || log "warn: CHECKPOINT failed (continuing)"
  fi
  local name
  name="$POOL@snapshot_$(date -u +%Y%m%d%H%M%S)"
  if zfs snapshot "$name"; then
    log "created $name (converged=$converged)"
    # Recorded on the snapshot itself and on the contract param so branch
    # tooling can tell a torn base from a clean one.
    zfs set "tendb:converged=$converged" "$name" 2>/dev/null || true
    pf_put_param snapshots/last-converged "$converged" 2>/dev/null || true
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

# Columns as "table<US>column<US>add-fragment" lines (US = \x01, immune to
# tabs in default expressions). The fragment is built server-side with
# quote_ident/format_type/pg_get_expr, so executing it verbatim is safe.
list_coldefs() { # $1=url
  psql "$1" -At -F $'\x01' -c "
    SELECT quote_ident(n.nspname) || '.' || quote_ident(c.relname),
           quote_ident(a.attname),
           quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod)
             || CASE WHEN a.attidentity = 'a' THEN ' GENERATED ALWAYS AS IDENTITY'
                     WHEN a.attidentity = 'd' THEN ' GENERATED BY DEFAULT AS IDENTITY'
                     WHEN a.attgenerated = 's' THEN ' GENERATED ALWAYS AS (' || pg_get_expr(d.adbin, d.adrelid) || ') STORED'
                     WHEN d.adbin IS NOT NULL THEN ' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid)
                     ELSE '' END
             || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')" | LC_ALL=C sort
}

# Plain indexes as "qualified_name<TAB>indexdef" lines. Constraint-backed
# indexes (PK/UNIQUE) are excluded: they cannot be dropped standalone, and a
# later-added PK already surfaces as column drift via its NOT NULL.
list_indexdefs() { # $1=url
  psql "$1" -At -F $'\t' -c "
    SELECT quote_ident(i.schemaname) || '.' || quote_ident(i.indexname), i.indexdef
    FROM pg_indexes i
    WHERE i.schemaname NOT IN ('pg_catalog', 'information_schema')
      AND NOT EXISTS (
        SELECT 1 FROM pg_constraint con
        JOIN pg_class ic ON ic.oid = con.conindid
        JOIN pg_namespace nsp ON nsp.oid = ic.relnamespace
        WHERE ic.relname = i.indexname AND nsp.nspname = i.schemaname)" | LC_ALL=C sort
}

# ADD publisher-only columns (both modes); DROP subscriber-only ones (full).
# Same-name-different-type is deliberately untouched: a rename is
# indistinguishable from drop+add, and guessing wrong loses sync-target data.
sync_columns() { # $1=mode $2=pub-url $3=sub-url — appends to SYNC_ERROR
  local mode="$1" pub="$2" sub="$3" pub_defs sub_defs add_keys drop_keys
  pub_defs=$(list_coldefs "$pub") || { SYNC_ERROR="${SYNC_ERROR:-cannot reach the publisher from snapshotd}"; return 1; }
  sub_defs=$(list_coldefs "$sub") || { SYNC_ERROR="${SYNC_ERROR:-cannot reach the sync target from snapshotd}"; return 1; }
  add_keys=$(comm -23 <(echo "$pub_defs" | cut -d $'\x01' -f 1,2) <(echo "$sub_defs" | cut -d $'\x01' -f 1,2))
  drop_keys=$(comm -13 <(echo "$pub_defs" | cut -d $'\x01' -f 1,2) <(echo "$sub_defs" | cut -d $'\x01' -f 1,2))

  # Tables where a NOT NULL add had to fall back to nullable this run; their
  # orphan columns are held back from the drop pass below.
  : > "$STATE_DIR/nullable-fallback"

  if [ -n "$add_keys" ]; then
    echo "$add_keys" | {
      ok=1
      while IFS=$'\x01' read -r t col; do
        [ -n "$t" ] || continue
        frag=$(echo "$pub_defs" | awk -F $'\x01' -v t="$t" -v c="$col" '$1 == t && $2 == c { print $3; exit }')
        log "adding column $t.$col"
        psql "$sub" -Atc "ALTER TABLE $t ADD COLUMN $frag" >/dev/null && continue
        # NOT NULL without a default cannot be added to a populated table —
        # the usual cause is a column RENAME upstream, which diffs as
        # drop+add. Add it nullable instead: that unblocks apply immediately,
        # which is what stops the publisher's WAL from growing, and the
        # column keeps reporting as drift (nullable here, NOT NULL upstream)
        # until someone backfills it. Deliberately NOT auto-backfilled from
        # the orphan column: same-type is not proof of a rename, and a wrong
        # guess writes bad data every branch would then inherit.
        nullable="${frag% NOT NULL}"
        if [ "$nullable" != "$frag" ] && psql "$sub" -Atc "ALTER TABLE $t ADD COLUMN $nullable" >/dev/null; then
          log "warn: added $t.$col as NULLABLE (NOT NULL rejected on a populated table — if this was a rename, the values are still in the column dropped upstream)"
          echo "$t" >> "$STATE_DIR/nullable-fallback"
        else
          log "warn: could not add column $t.$col"; ok=0
        fi
      done
      [ "$ok" = 1 ]
    } || SYNC_ERROR="${SYNC_ERROR:-some columns failed to sync (see snapshotd logs)}"
  fi

  if [ "$mode" = "full" ] && [ -n "$drop_keys" ]; then
    echo "$drop_keys" | {
      ok=1
      while IFS=$'\x01' read -r t col; do
        [ -n "$t" ] || continue
        # Dropping here would destroy the only copy of a renamed column's
        # data on the sync target.
        if grep -qxF "$t" "$STATE_DIR/nullable-fallback" 2>/dev/null; then
          log "keeping orphan column $t.$col — $t just took a nullable fallback and this may hold its values"
          continue
        fi
        log "dropping column $t.$col"
        psql "$sub" -Atc "ALTER TABLE $t DROP COLUMN $col" >/dev/null || { log "warn: could not drop column $t.$col"; ok=0; }
      done
      [ "$ok" = 1 ]
    } || SYNC_ERROR="${SYNC_ERROR:-some columns failed to sync (see snapshotd logs)}"
  fi
}

# CREATE publisher-only indexes (both modes); DROP subscriber-only ones first
# in full mode, so a renamed/redefined index converges as drop-then-create.
# Plain CREATE INDEX briefly blocks apply while it builds — fine on a replica;
# the slot retains WAL meanwhile.
sync_indexes() { # $1=mode $2=pub-url $3=sub-url — appends to SYNC_ERROR
  local mode="$1" pub="$2" sub="$3" pub_idx sub_idx missing orphaned
  pub_idx=$(list_indexdefs "$pub") || { SYNC_ERROR="${SYNC_ERROR:-cannot reach the publisher from snapshotd}"; return 1; }
  sub_idx=$(list_indexdefs "$sub") || { SYNC_ERROR="${SYNC_ERROR:-cannot reach the sync target from snapshotd}"; return 1; }
  missing=$(comm -23 <(echo "$pub_idx") <(echo "$sub_idx"))
  orphaned=$(comm -13 <(echo "$pub_idx") <(echo "$sub_idx"))

  if [ "$mode" = "full" ] && [ -n "$orphaned" ]; then
    echo "$orphaned" | {
      ok=1
      while IFS=$'\t' read -r name _def; do
        [ -n "$name" ] || continue
        log "dropping index $name"
        psql "$sub" -Atc "DROP INDEX IF EXISTS $name" >/dev/null || { log "warn: could not drop index $name"; ok=0; }
      done
      [ "$ok" = 1 ]
    } || SYNC_ERROR="${SYNC_ERROR:-some indexes failed to sync (see snapshotd logs)}"
  fi

  if [ -n "$missing" ]; then
    echo "$missing" | {
      ok=1
      while IFS=$'\t' read -r name def; do
        [ -n "$name" ] || continue
        log "creating index $name"
        psql "$sub" -Atc "$def" >/dev/null || { log "warn: could not create index $name"; ok=0; }
      done
      [ "$ok" = 1 ]
    } || SYNC_ERROR="${SYNC_ERROR:-some indexes failed to sync (see snapshotd logs)}"
  fi
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

  # After the table pass so new tables already exist on both sides (their
  # columns and indexes then diff clean) and orphans are already gone.
  sync_columns "$mode" "$pub" "$sub"
  sync_indexes "$mode" "$pub" "$sub"

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
        take_snapshot scheduled
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
