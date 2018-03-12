#!/bin/bash

usage() {
  echo "Usage: db_restore.sh -d DBNAME -U dbuser -f DBDUMP_FILE";
  echo "e.g.";
  echo "> db_restore.sh -d wwcode_test -U dbuser -f opencollective-api/test/dbdumps/wwcode_test.pgsql"
  exit 0;
}

# Parse command line arguments
while [[ $# -gt 1 ]]
do
    key="$1"
    case $key in
        -d|--dbname)
            LOCALDBNAME="$2"; shift;;
        -U|--username)
            LOCALDBUSER="$2"; shift;;
        -f|--file)
            DBDUMP_FILE="$2"; shift;;
        *)
            usage; exit 1;;
    esac
    shift
done

# Can't go on without target database defined
if [ -z "$LOCALDBNAME" ]; then usage; fi;

# Defaults to `opencollective' user
LOCALDBUSER=${LOCALDBUSER:-"opencollective"}

# Debug output
echo "LOCALDBUSER=$LOCALDBUSER"
echo "LOCALDBNAME=$LOCALDBNAME"
echo "DBDUMP_FILE=$DBDUMP_FILE"

# Terminate all the queries that are still running. It prints out the
# content of the queries being killed. Should be useful for finding
# out why they're still running.
cat <<-EOF | psql -U $LOCALDBUSER postgres
    SELECT pg_terminate_backend(pid), query
    FROM pg_stat_activity
    WHERE pid <> pg_backend_pid()
    AND datname = '${LOCALDBNAME}';
EOF

## Recreate database from scratch. No steps should fail here as well
if ! dropdb $LOCALDBNAME; then
    echo "db_restore.sh: Failed to drop target database"
    exit 1
fi
if ! createdb -O $LOCALDBUSER $LOCALDBNAME; then
    echo "db_restore.sh: Failed to create new target database"
    exit 1
fi

# This is needed because only super users can create extensions and we
# don't want to make the `opencollective` user a super user, so we
# create the extension as the user running this script & then grant
# all the permissions to the `LOCALDBUSER` which is `opencollective`
# in pretty much all the environments.
if ! psql -d $LOCALDBNAME -c "CREATE EXTENSION POSTGIS;"; then
    echo "db_restore.sh: Failed to create POSTGIS extension in target database"
    exit 1
fi
if ! psql -d $LOCALDBNAME -c "GRANT ALL PRIVILEGES ON spatial_ref_sys TO ${LOCALDBUSER};"; then
    echo "db_restore.sh: Failed to give user permissions to POSTGIS table"
    exit 1
fi

# Restore should not generate any errors. If it does, the whole
# restoration will exit with error and that error should be fixed.
if ! pg_restore --no-acl --no-owner --clean --schema=public \
     --if-exists --role=$LOCALDBUSER --dbname=$LOCALDBNAME \
     $DBDUMP_FILE;
then
    echo "db_restore.sh: Failed to restore dump file into target database"
    exit 1
fi

echo "DB restored to postgres://localhost/${LOCALDBNAME}"
