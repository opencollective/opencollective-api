#!/bin/bash
# Refreshes test/dbdumps/opencollective_dvl.pgsql: restores it (unless RESTORE=false), runs the
# migrations, sanitizes the data and dumps it back. Commit the new dump so that restores don't
# have to replay every migration since the last refresh.
#
# DBNAME (default: opencollective_dvl) is the database used for that, and is dropped unless
# RESTORE=false. Use RESTORE=false to dump data you added to it on purpose.

DBNAME=${DBNAME:-"opencollective_dvl"}
DUMPFILE="test/dbdumps/opencollective_dvl.pgsql"

set -e

. ./scripts/common/pg-tools.sh

if [ "$RESTORE" != "false" ]; then
  ./scripts/common/confirm.sh "This drops the database $DBNAME to make a fresh dump without polluted data (pass RESTORE=false to keep it, or DBNAME=<other> to use another one). Drop $DBNAME? (yes/no) " || exit 1
  ./scripts/db_restore.sh -d "$DBNAME" -U opencollective -f "$DUMPFILE"
fi

echo "Migrating $DBNAME"
PG_DATABASE=$DBNAME npm run db:migrate
PG_DATABASE=$DBNAME npm run db:sanitize

pg_tool pg_dump -O -F t -h "$PG_HOST" -U opencollective "$DBNAME" >"$DUMPFILE"

echo "$DUMPFILE refreshed. Please commit it and push it."
