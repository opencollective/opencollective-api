#!/bin/sh

while [ "$#" -gt 0 ]; do
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
  *)
    # unknown option
    ;;
  esac
  shift # past argument or value
done

LOCALDBUSER=${LOCALDBUSER:-"opencollective"}
LOCALDBNAME=${LOCALDBNAME:-"opencollective_dvl"}
PG_HOST=${PG_HOST:-"localhost"}

echo "LOCALDBUSER=$LOCALDBUSER"
echo "LOCALDBNAME=$LOCALDBNAME"
echo "PG_HOST=$PG_HOST"

if [ -z "$LOCALDBNAME" ]; then usage; fi

# Adapt commands based on docker usage
CMD_PSQL="psql"

if [ "$USE_DOCKER" = "true" ] || [ "$USE_PODMAN" = "true" ]; then
  if [ "$USE_DOCKER" = "true" ]; then
    echo "Using docker to run Postgres commands"
    CMD_DOCKER="./scripts/dev/run-docker.sh run --rm --network host"
  else
    echo "Using podman to run Postgres commands"
    CMD_DOCKER="podman run --rm --network host"
  fi
  CMD_PSQL="$CMD_DOCKER postgres:16 psql"
fi

set -e

# When restoring old backups, you may need to enable Postgis
if [ "$USE_POSTGIS" = "1" ]; then
  echo "Enabling Postgis"
  $CMD_PSQL -U postgres -h $PG_HOST "${LOCALDBNAME}" -c "CREATE EXTENSION postgis;"
  $CMD_PSQL -U postgres -h $PG_HOST "${LOCALDBNAME}" -c "ALTER TABLE public.spatial_ref_sys OWNER TO ${LOCALDBUSER};"
  $CMD_PSQL -U postgres -h $PG_HOST "${LOCALDBNAME}" -c "GRANT SELECT, INSERT ON TABLE public.spatial_ref_sys TO public;"
fi

echo "Enabling btree_gist"
$CMD_PSQL -U postgres -h $PG_HOST $LOCALDBNAME -c "CREATE EXTENSION IF NOT EXISTS btree_gist;"

echo "Enabling pg_trgm"
$CMD_PSQL -U postgres -h $PG_HOST $LOCALDBNAME -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"
