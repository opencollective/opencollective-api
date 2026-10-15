#!/bin/bash
# Copies the staging database to a local opencollective_staging_snapshot database.
# Usage: npm run db:copy:staging
#
# Then run the API on it with: PG_DATABASE=opencollective_staging_snapshot npm run dev

set -e

LOCALDBNAME="opencollective_staging_snapshot"
DBDUMPS_DIR="dbdumps"
DUMPFILE="${DBDUMPS_DIR}/$(date +"%Y-%m-%d")-staging.pgsql"

. ./scripts/common/pg-tools.sh

mkdir -p "$DBDUMPS_DIR"

if [[ ! -s $DUMPFILE ]]; then
  echo "Downloading the latest staging backup to $DUMPFILE"
  heroku pg:backups:download -a opencollective-staging-api -o "$DUMPFILE"
fi

./scripts/db_restore.sh -h "$PG_HOST" -d "$LOCALDBNAME" -U opencollective -f "$DUMPFILE"

echo "
To start the API on it, run:

PG_DATABASE=$LOCALDBNAME npm run dev
"
