#!/bin/bash
# This scripts migrates the schema of the opencollective_dvl db (with sanitized data)
# And updates the dump export for tests in test/dbdumps/opencollective_dvl.pgsql

PG_DATABASE=opencollective_dvl
DUMPFILE="test/dbdumps/$PG_DATABASE.pgsql"
./scripts/db_restore.sh -d $PG_DATABASE -U opencollective -f $DUMPFILE
echo "Migrating $PG_DATABASE"
DEBUG=psql PG_DATABASE=$PG_DATABASE npm run db:migrate
PG_DATABASE=$PG_DATABASE npm run db:sanitize
pg_dump -O -F t $PG_DATABASE >$DUMPFILE
# Uncomment the line below to use a specific version of pg_dump (using docker)
# (sudo docker run --rm --network host postgres:14.5 pg_dump -O -F t -h localhost -p 5432 -U opencollective $PG_DATABASE) >$DUMPFILE

echo "$DUMPFILE migrated. Please commit it and push it."
echo ""
