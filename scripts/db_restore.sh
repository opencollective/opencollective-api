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
DBDUMP_FILE=${DBDUMP_FILE:-"./test/dbdumps/opencollective_dvl.pgsql"}

echo "LOCALDBUSER=$LOCALDBUSER"
echo "LOCALDBNAME=$LOCALDBNAME"
echo "DBDUMP_FILE=$DBDUMP_FILE"

if [ -z "$LOCALDBNAME" ]; then usage; fi

# kill all connections to the postgres server
# echo "Killing all connections to database '$LOCALDBNAME'"

# cat <<-EOF | psql -U $LOCALDBUSER -d $LOCALDBNAME
# SELECT pg_terminate_backend(pg_stat_activity.pid)
# FROM pg_stat_activity
# where pg_stat_activity.datname = '$LOCALDBNAME'
# EOF

echo "Dropping '$LOCALDBNAME'"
dropdb -U postgres -h localhost --if-exists $LOCALDBNAME

echo "Creating '$LOCALDBNAME'"
createdb -U postgres -h localhost $LOCALDBNAME 2>/dev/null

# When restoring old backups, you may need to enable Postgis
if [ "$USE_POSTGIS" = "1" ]; then
  echo "Enabling Postgis"
  psql "${LOCALDBNAME}" -c "CREATE EXTENSION postgis;"
  psql "${LOCALDBNAME}" -c "ALTER TABLE public.spatial_ref_sys OWNER TO ${LOCALDBUSER};"
  psql "${LOCALDBNAME}" -c "GRANT SELECT, INSERT ON TABLE public.spatial_ref_sys TO public;"
fi

# cool trick: all stdout ignored in this block
{
  set +e
  # We make sure the user $LOCALDBUSER has access; could fail
  psql -U postgres -h localhost "${LOCALDBNAME}" -c "CREATE ROLE ${LOCALDBUSER} WITH login;" 2>/dev/null
  set -e
} | tee >/dev/null

# Update table permissions
echo "Updating table permissions"
psql -U postgres -h localhost $LOCALDBNAME -c "GRANT ALL ON SCHEMA public TO ${LOCALDBUSER};"

PG_RESTORE_OPTIONS=(-U postgres -h localhost --no-acl --no-owner --role="${LOCALDBUSER}" -n public -O -d "${LOCALDBNAME}")
PG_RESTORE_COMMAND=pg_restore
if [ -n "$USE_DOCKER" ]; then
  PG_RESTORE_COMMAND="sudo docker run --rm --network host -v $(dirname "$DBDUMP_FILE"):/backup postgres:14 pg_restore -h localhost -p 5432 -U opencollective"
  DBDUMP_FILE="/backup/$(basename "$DBDUMP_FILE")"
fi

# The first time we run it with the -s option (schema only)
echo "Restoring schema"
$PG_RESTORE_COMMAND "${PG_RESTORE_OPTIONS[@]}" -s "${DBDUMP_FILE}"

# Disable triggers
echo "Disabling triggers"
psql -U postgres -h localhost "${LOCALDBNAME}" -c "
DO \$\$ 
BEGIN 
   EXECUTE (
      SELECT string_agg(
         format('ALTER TABLE %I.%I DISABLE TRIGGER ALL', schemaname, tablename), '; '
      ) 
      FROM pg_tables 
      WHERE schemaname = 'public'
   ); 
END \$\$;
"

# Restore data (-a flag)
echo "Restoring data"
$PG_RESTORE_COMMAND "${PG_RESTORE_OPTIONS[@]}" -a "${DBDUMP_FILE}"

# Re-enable triggers
echo "Re-enabling triggers"
psql -U postgres -h localhost "${LOCALDBNAME}" -c "
DO \$\$ 
BEGIN 
   EXECUTE (
      SELECT string_agg(
         format('ALTER TABLE %I.%I ENABLE TRIGGER ALL', schemaname, tablename), '; '
      ) 
      FROM pg_tables 
      WHERE schemaname = 'public'
   ); 
END \$\$;
"

echo "DB restored to postgres://localhost/${LOCALDBNAME}"

# Note: I have to run after this script:
# $> psql opencollective_test -c "REASSIGN OWNED BY xdamman TO opencollective;"
# Because the views created by the CIS extension are not owned by the opencollective user
