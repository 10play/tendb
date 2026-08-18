-- Run on AURORA as the master user, after seeding. Pass the replication
-- password in with:  psql -v repl_password="'<password>'" -f publisher.sql
--
-- rds_replication grants the REPLICATION-equivalent capability on RDS/Aurora
-- (plain `CREATE ROLE ... REPLICATION` is reserved to the rdsadmin user).
create role tendb_repl with login password :repl_password;
grant rds_replication to tendb_repl;
grant usage on schema public to tendb_repl;
grant select on all tables in schema public to tendb_repl;
alter default privileges in schema public grant select on tables to tendb_repl;

create publication tendb_source for all tables;
