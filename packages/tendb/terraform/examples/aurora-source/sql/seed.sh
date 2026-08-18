#!/usr/bin/env bash
# Copy one database into another so a subscription can start with
# copy_data=false: seed, then subscribe, and write nothing to the source in
# between. Used twice in this rehearsal — legacy source → Aurora (once), and
# Aurora → the engine-host sync target.
#
# Uses a postgres:18 container so the client tools match the servers.
#
#   FROM_URL=postgres://... TO_URL=postgres://... ./seed.sh
set -euo pipefail

: "${FROM_URL:?set FROM_URL to the source connection string}"
: "${TO_URL:?set TO_URL to the destination connection string}"

docker run --rm -e FROM_URL -e TO_URL postgres:18 sh -ceu '
  pg_dump --no-owner --no-privileges "$FROM_URL" | psql --set ON_ERROR_STOP=1 --quiet "$TO_URL"
'
echo "seeded. destination row counts:"
docker run --rm -e TO_URL postgres:18 \
  psql "$TO_URL" -c "select relname, n_live_tup from pg_stat_user_tables order by relname"
