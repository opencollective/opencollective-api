#!/bin/sh
# Recreates a local database from a dump.
# Usage: db_restore.sh [-d DBNAME] [-U DBUSER] [-h HOST] [-f DBDUMP_FILE]
# e.g. db_restore.sh -d opencollective_dvl -U opencollective -f test/dbdumps/opencollective_dvl.pgsql

while [ "$#" -gt 0 ]; do
  case "$1" in
  -d | --dbname) LOCALDBNAME="$2"; shift ;;
  -h | --host) PG_HOST="$2"; shift ;;
  -U | --username) LOCALDBUSER="$2"; shift ;;
  -f | --file) DBDUMP_FILE="$2"; shift ;;
  esac
  shift
done

LOCALDBUSER=${LOCALDBUSER:-"opencollective"}
LOCALDBNAME=${LOCALDBNAME:-"opencollective_dvl"}
DBDUMP_FILE=${DBDUMP_FILE:-"test/dbdumps/opencollective_dvl.pgsql"}

. ./scripts/common/pg-tools.sh

set -e

echo "Recreating '$LOCALDBNAME' on $PG_HOST"
pg_tool dropdb -U postgres -h "$PG_HOST" --if-exists --force "$LOCALDBNAME"
pg_tool createdb -U postgres -h "$PG_HOST" "$LOCALDBNAME"

./scripts/db_restore_extensions.sh -d "$LOCALDBNAME" -U "$LOCALDBUSER" -h "$PG_HOST"

echo "Restoring $DBDUMP_FILE"
pg_tool pg_restore -U postgres -h "$PG_HOST" --no-acl --no-owner --role="$LOCALDBUSER" -n public --exit-on-error \
  -d "$LOCALDBNAME" <"$DBDUMP_FILE"

echo "DB restored to postgres://$PG_HOST/$LOCALDBNAME"
