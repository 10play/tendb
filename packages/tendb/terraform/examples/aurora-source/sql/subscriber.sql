-- Run on the ENGINE-HOST SYNC TARGET (the Postgres 18 container on :5433 that
-- the engine dumps from). Pass the Aurora endpoint and replication password:
--   psql -v aurora_conn="'host=<endpoint> port=5432 dbname=tendb user=tendb_repl password=<pw> sslmode=require'" \
--        -f subscriber.sql
--
-- copy_data=false because the sync target was seeded FROM Aurora and nothing
-- has written to Aurora since — the states are identical, so streaming starts
-- from the slot's creation point with no initial copy.
create subscription tendb_stream
  connection :aurora_conn
  publication tendb_source
  with (copy_data = false);
