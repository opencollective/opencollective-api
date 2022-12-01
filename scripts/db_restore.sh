#!/bin/bash

usage() {
  echo "Usage: db_restore.sh -d DBNAME -U DBUSER -f DBDUMP_FILE";
  echo "e.g.";
  echo "> db_restore.sh -d opencollective_dvl -U opencollective -f test/dbdumps/opencollective_dvl.pgsql"
  exit 0;
}

while [[ $# -gt 1 ]]
do
key="$1"

case $key in
    -d|--dbname)
    LOCALDBNAME="$2"
    shift # past argument
    ;;
    -U|--username)
    LOCALDBUSER="$2"
    shift # past argument
    ;;
    -f|--file)
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

echo "LOCALDBUSER=$LOCALDBUSER"
echo "LOCALDBNAME=$LOCALDBNAME"
echo "DBDUMP_FILE=$DBDUMP_FILE"

if [ -z "$LOCALDBNAME" ]; then usage; fi;

# kill all connections to the postgres server
# echo "Killing all connections to database '$LOCALDBNAME'"

# cat <<-EOF | psql -U $LOCALDBUSER -d $LOCALDBNAME
# SELECT pg_terminate_backend(pg_stat_activity.pid)
# FROM pg_stat_activity
# where pg_stat_activity.datname = '$LOCALDBNAME'
# EOF

dropdb -U postgres -h localhost --if-exists $LOCALDBNAME;
createdb -U postgres -h localhost $LOCALDBNAME 2> /dev/null

# When restoring old backups, you may need to enable Postgis
# psql "${LOCALDBNAME}" -c "CREATE EXTENSION postgis;"

# cool trick: all stdout ignored in this block
{
  set +e
  # We make sure the user $LOCALDBUSER has access; could fail
  psql -U postgres -h localhost "${LOCALDBNAME}" -c "CREATE ROLE ${LOCALDBUSER} WITH login;" 2>/dev/null
  set -e
} | tee >/dev/null

# The first time we run it, we will trigger FK constraints errors
set +e
pg_restore -U postgres -h localhost --no-acl --no-owner --role=${LOCALDBUSER} -n public -O -c -d "${LOCALDBNAME}" "${DBDUMP_FILE}" 2>/dev/null
set -e

# So we run it twice :-)
pg_restore -U postgres -h localhost --no-acl --no-owner --role=${LOCALDBUSER} -n public -O -c -d "${LOCALDBNAME}" "${DBDUMP_FILE}"

echo "DB restored to postgres://localhost/${LOCALDBNAME}"

# Note: I have to run after this script:
# $> psql opencollective_test -c "REASSIGN OWNED BY xdamman TO opencollective;"
# Because the views created by the CIS extension are not owned by the opencollective user
