#!/bin/bash

usage() {
  echo "Usage: db_restore.sh -d DBNAME -U DBUSER --use-postgis -f DBDUMP_FILE"
  echo "e.g."
  echo "> db_restore.sh -d opencollective_dvl -U opencollective -f test/dbdumps/opencollective_dvl.pgsql"
  exit 0
}

while [[ $# -gt 0 ]]; do
  key="$1"

  case $key in
  -d | --dbname)
    LOCALDBNAME="$2"
    shift # past argument
    ;;
  -h | --host)
    PG_HOST="$2"
    shift # past argument
    ;;
  -U | --username)
    LOCALDBUSER="$2"
    shift # past argument
    ;;
  --use-postgis)
    USE_POSTGIS=1
    ;;
  -f | --file)
    DBDUMP_FILE="$2"
    shift # past argument
    ;;
  *)
    # unknown option
    ;;
  esac
  shift # past argument or value
done

LOCALDBUSER=${LOCALDBUSER:-"opencollective"}
LOCALDBNAME=${LOCALDBNAME:-"opencollective_dvl"}
DBDUMP_FILE=${DBDUMP_FILE:-"test/dbdumps/opencollective_dvl.pgsql"}
LOCAL_FILE=$DBDUMP_FILE
PG_HOST=${PG_HOST:-"localhost"}

echo "LOCALDBUSER=$LOCALDBUSER"
echo "LOCALDBNAME=$LOCALDBNAME"
echo "DBDUMP_FILE=$DBDUMP_FILE"
echo "PG_HOST=$PG_HOST"

if [ -z "$LOCALDBNAME" ]; then usage; fi

# kill all connections to the postgres server
# echo "Killing all connections to database '$LOCALDBNAME'"

# cat <<-EOF | psql -U $LOCALDBUSER -d $LOCALDBNAME
# SELECT pg_terminate_backend(pg_stat_activity.pid)
# FROM pg_stat_activity
# where pg_stat_activity.datname = '$LOCALDBNAME'
# EOF

# Adapt commands based on docker usage
CMD_DROP_DB="dropdb"
CMD_CREATE_DB="createdb"
CMD_PSQL="psql"
CMD_PG_RESTORE="pg_restore"

if [ "$USE_DOCKER" = "true" || "$USE_PODMAN" = "true" ]; then
  if [ "$USE_DOCKER" = "true" ]; then
    echo "Using docker to run Postgres commands"
    CMD_DOCKER="./scripts/dev/run-docker.sh run --rm --network host"
  else
    echo "Using podman to run Postgres commands"
    CMD_DOCKER="podman run --rm --network host"
  fi
  CMD_DROP_DB="$CMD_DOCKER postgres:16 dropdb"
  CMD_CREATE_DB="$CMD_DOCKER postgres:16 createdb"
  CMD_PSQL="$CMD_DOCKER postgres:16 psql"
  CMD_PG_RESTORE="$CMD_DOCKER -v ./$(dirname "$DBDUMP_FILE"):/dbdumps:Z postgres:16 pg_restore"
  LOCAL_FILE="/dbdumps/$(basename "$DBDUMP_FILE")"
fi

set -e

echo "Dropping '$LOCALDBNAME'"
$CMD_DROP_DB -U postgres -h $PG_HOST --if-exists $LOCALDBNAME

echo "Creating '$LOCALDBNAME'"
$CMD_CREATE_DB -U postgres -h $PG_HOST $LOCALDBNAME 2>/dev/null

# When restoring old backups, you may need to enable Postgis
if [ "$USE_POSTGIS" = "1" ]; then
  echo "Enabling Postgis"
  $CMD_PSQL "${LOCALDBNAME}" -c "CREATE EXTENSION postgis;"
  $CMD_PSQL "${LOCALDBNAME}" -c "ALTER TABLE public.spatial_ref_sys OWNER TO ${LOCALDBUSER};"
  $CMD_PSQL "${LOCALDBNAME}" -c "GRANT SELECT, INSERT ON TABLE public.spatial_ref_sys TO public;"
fi

$CMD_PSQL -U postgres -h $PG_HOST $LOCALDBNAME -c "CREATE EXTENSION IF NOT EXISTS btree_gist;"

# cool trick: all stdout ignored in this block
{
  set +e
  # We make sure the user $LOCALDBUSER has access; could fail
  $CMD_PSQL -U postgres -h $PG_HOST "${LOCALDBNAME}" -c "CREATE ROLE ${LOCALDBUSER} WITH login;" 2>/dev/null
  set -e
} | tee >/dev/null

# Update table permissions
echo "Updating table permissions"
$CMD_PSQL -U postgres -h $PG_HOST $LOCALDBNAME -c "GRANT ALL ON SCHEMA public TO ${LOCALDBUSER};"

# The first time we run it, we will trigger FK constraints errors
set +e
$CMD_PG_RESTORE -U postgres -h $PG_HOST --no-acl --no-owner --role=${LOCALDBUSER} -n public -O -c -d "${LOCALDBNAME}" "${LOCAL_FILE}" 2>/dev/null
set -e

# So we run it twice :-)
$CMD_PG_RESTORE -U postgres -h $PG_HOST --no-acl --no-owner --role=${LOCALDBUSER} -n public -O -c -d "${LOCALDBNAME}" "${LOCAL_FILE}"

echo "DB restored to postgres://$PG_HOST/${LOCALDBNAME}"

# Note: I have to run after this script:
# $> psql opencollective_test -c "REASSIGN OWNED BY xdamman TO opencollective;"
# Because the views created by the CIS extension are not owned by the opencollective user
