#!/bin/bash
# This scripts migrates the schema of the opencollective_dvl db (with sanitized data)
# And updates the dump export for tests in test/dbdumps/opencollective_dvl.pgsql

PG_DATABASE=opencollective_dvl
DUMPFILE="test/dbdumps/$PG_DATABASE.pgsql"

set -e

if [ "$RESTORE" != "false" ]; then
  echo "Restoring $PG_DATABASE to latest snapshot"

  # Add a confirmation before running the restore
  ./scripts/common/confirm.sh "The next command will drop the database $PG_DATABASE in order to make a fresh dump without polluted data. You can avoid this by passing RESTORE=false. Are you sure you want to drop $PG_DATABASE? (yes/no) " || exit 1
  ./scripts/db_restore.sh -d $PG_DATABASE -U opencollective -f $DUMPFILE
fi

echo "Migrating $PG_DATABASE"
DEBUG=psql PG_DATABASE=$PG_DATABASE npm run db:migrate
PG_DATABASE=$PG_DATABASE npm run db:sanitize

# Run docker if $USE_DOCKER is set
if [ "$USE_DOCKER" = "true" ]; then
  echo "Using docker to run pg_dump"
  (./scripts/dev/run-docker.sh run --rm --network host postgres:16 pg_dump -O -F t -h localhost -p 5432 -U opencollective $PG_DATABASE) >$DUMPFILE
else
  pg_dump -O -F t $PG_DATABASE >$DUMPFILE
fi

echo "$DUMPFILE migrated. Please commit it and push it."
echo ""
