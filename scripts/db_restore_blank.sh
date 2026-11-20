#!/bin/sh
# Restores the blank database dump (schema with all migrations pre-loaded).
#
# Usage: npm run db:restore:blank [-- [-d <database>] [-h <host>] [-U <user>] [--use-postgis] [--yes]]
#
# The target database is, in order of priority:
#   1. -d <database>
#   2. $PG_DATABASE from the environment
#   3. PG_DATABASE from the .env file
#   4. opencollective_blank
#
# Restoring drops the target first, so an existing database is only replaced with --yes (-y).
# The other options are db_restore.sh's; anything else is refused, so the database this script
# checks is always the one db_restore.sh restores.

. ./scripts/db_env.sh

TARGET_DB="${PG_DATABASE:-$DEFAULT_BLANK_DB}"
TARGET_HOST="$PG_HOST"
TARGET_USER=""
USE_POSTGIS=""
CONFIRMED=false

usage_error() {
  echo "$1" >&2
  echo "Usage: npm run db:restore:blank [-- [-d <database>] [-h <host>] [-U <user>] [--use-postgis] [--yes]]" >&2
  exit 1
}

# Consumes each option with its value, like db_restore.sh does.
while [ "$#" -gt 0 ]; do
  case "$1" in
    -d | --dbname | -h | --host | -U | --username)
      [ "$#" -ge 2 ] || usage_error "Missing value for $1."
      case "$1" in
        -d | --dbname) TARGET_DB="$2" ;;
        -h | --host) TARGET_HOST="$2" ;;
        *) TARGET_USER="$2" ;;
      esac
      shift 2
      ;;
    --use-postgis)
      USE_POSTGIS=--use-postgis
      shift
      ;;
    -y | --yes)
      CONFIRMED=true
      shift
      ;;
    -f | --file) usage_error "The blank restore always uses test/dbdumps/schema-with-migrations.pgsql." ;;
    *) usage_error "Unknown argument: $1" ;;
  esac
done

# db_restore.sh connects to localhost when the host is empty: check the same server.
TARGET_HOST="${TARGET_HOST:-localhost}"

# An empty name would make db_restore.sh fall back to its own default database, unchecked.
if [ -z "$TARGET_DB" ]; then
  echo "No database to restore: pass -d <database>." >&2
  exit 1
fi

# Same Postgres client as db_restore.sh
CMD_PSQL="psql"
if [ "$USE_DOCKER" = "true" ]; then
  CMD_PSQL="./scripts/dev/run-docker.sh run --rm --network host postgres:16 psql"
elif [ "$USE_PODMAN" = "true" ]; then
  CMD_PSQL="podman run --rm --network host postgres:16 psql"
fi

if ! EXISTS=$($CMD_PSQL -w -U postgres -h "$TARGET_HOST" -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname = '$TARGET_DB'"); then
  echo "Could not check whether database '$TARGET_DB' exists on $TARGET_HOST; nothing was restored." >&2
  exit 1
fi

if [ "$EXISTS" = "1" ] && [ "$CONFIRMED" != "true" ]; then
  echo "Database '$TARGET_DB' already exists on $TARGET_HOST and would be dropped." >&2
  echo "Replace it with: npm run db:restore:blank -- -d $TARGET_DB --yes" >&2
  exit 1
fi

exec ./scripts/db_restore.sh -d "$TARGET_DB" -h "$TARGET_HOST" ${TARGET_USER:+-U "$TARGET_USER"} $USE_POSTGIS \
  -f test/dbdumps/schema-with-migrations.pgsql
