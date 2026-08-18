#!/usr/bin/env bash
# Demo traffic: insert a transaction into Aurora every INTERVAL seconds so the
# console's Source pipeline card has something to show. Ctrl-C to stop.
#
#   AURORA_URL=postgres://... ./loadgen.sh [interval-seconds]
#
# transactions.id has no default in the seed schema, so the id is computed
# inline — fine for a single-writer demo loop, not a pattern for real apps.
set -euo pipefail

: "${AURORA_URL:?set AURORA_URL to the Aurora connection string}"
INTERVAL="${1:-2}"

echo "inserting a transaction every ${INTERVAL}s — ctrl-c to stop"
while true; do
  psql "$AURORA_URL" --quiet --no-align --tuples-only -c "
    insert into transactions (id, customer_id, amount_usd, status, created_at)
    select coalesce(max(id), 0) + 1,
           (1 + floor(random() * 5000))::int,
           round((100 + random() * 9000)::numeric, 2),
           (array['settled','pending','failed'])[1 + floor(random() * 3)],
           now()
    from transactions
    returning 'inserted id ' || id || ' at ' || now()::time(0)"
  sleep "$INTERVAL"
done
