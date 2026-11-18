#!/bin/sh
# Seeds a database with sample data for local development.
#
# Usage: npm run db:seed <database>
# e.g.   npm run db:seed opencollective_blank
#
# The database must be named explicitly: neither the environment nor the .env file picks it, so a
# configured development database is never seeded by accident. It should be a freshly restored blank
# one (see `npm run db:restore:blank`). Refuses to run when OC_ENV is production.

. ./scripts/db_env.sh

if [ "$OC_ENV" = "production" ]; then
  echo "Refusing to seed sample data: OC_ENV is production." >&2
  exit 1
fi

if [ -z "$1" ] || [ "${1#-}" != "$1" ]; then
  echo "Name the database to seed: npm run db:seed <database>" >&2
  exit 1
fi

export PG_DATABASE="$1"
shift

exec npx babel-node --extensions .js,.ts ./scripts/db_seed.ts "$@"
