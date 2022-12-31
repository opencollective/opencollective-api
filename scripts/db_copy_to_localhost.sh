#!/bin/bash
# This shell scripts copies the production database to the local database
# Usage: npm run db:copyprod (from the root of the opencollective-api repo)
#
# To run the API with the local version of the production database, run:
# PG_DATABASE=opencollective_prod_snapshot npm start

ENV="${1}"
set -e

if [[ ${ENV} != staging ]] && [[ ${ENV} != prod ]]; then
  echo "You must specify from which environment you want to pull the database (valid values: 'staging' or 'prod')"
  exit 1;
fi

LOCALDBUSER="opencollective"
LOCALDBNAME="opencollective_${ENV}_snapshot"
DBDUMPS_DIR="dbdumps/"

FILENAME="`date +"%Y-%m-%d"`-prod.pgsql"

if [[ ! -d ${DBDUMPS_DIR} ]]; then
  mkdir -p "${DBDUMPS_DIR}"
fi

if [[ ! -s ${DBDUMPS_DIR}${FILENAME} ]]; then
  PG_URL_ENVIRONMENT_VARIABLE=`heroku config:get PG_URL_ENVIRONMENT_VARIABLE -a "opencollective-${ENV}-api"`
  PG_URL_ENVIRONMENT_VARIABLE="${PG_URL_ENVIRONMENT_VARIABLE:-DATABASE_URL}"
  PG_URL=`heroku config:get ${PG_URL_ENVIRONMENT_VARIABLE} -a "opencollective-${ENV}-api"`
  echo "Dumping ${ENV} database"
  pg_dump -O -F t "${PG_URL}" > "${DBDUMPS_DIR}${FILENAME}"
fi

echo "DB dump saved in ${DBDUMPS_DIR}${FILENAME}"

echo Restore...
./scripts/db_restore.sh -d $LOCALDBNAME -U $LOCALDBUSER -f ${DBDUMPS_DIR}${FILENAME}

echo "
---------
All done!
---------

To start the OpenCollective API with the local version of the production database, run:

PG_DATABASE=\"${LOCALDBNAME}\" npm start
"