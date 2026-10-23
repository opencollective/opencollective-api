#!/bin/sh
# Prepares a local database for the app: the role it connects with (superuser, required for
# migrations) and the extensions it needs.
# Usage: db_restore_extensions.sh [-d DBNAME] [-U DBUSER] [-h HOST]

while [ "$#" -gt 0 ]; do
  case "$1" in
  -d | --dbname) LOCALDBNAME="$2"; shift ;;
  -h | --host) PG_HOST="$2"; shift ;;
  -U | --username) LOCALDBUSER="$2"; shift ;;
  esac
  shift
done

LOCALDBUSER=${LOCALDBUSER:-"opencollective"}
LOCALDBNAME=${LOCALDBNAME:-"opencollective_dvl"}

. ./scripts/common/pg-tools.sh

set -e

echo "Preparing role '$LOCALDBUSER' and extensions on '$LOCALDBNAME'"
pg_tool psql -q -v ON_ERROR_STOP=1 -U postgres -h "$PG_HOST" -d "$LOCALDBNAME" <<EOF
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$LOCALDBUSER') THEN
    CREATE ROLE "$LOCALDBUSER" WITH LOGIN SUPERUSER;
  ELSE
    ALTER ROLE "$LOCALDBUSER" WITH SUPERUSER;
  END IF;
END \$\$;
GRANT ALL ON SCHEMA public TO "$LOCALDBUSER";
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
EOF
