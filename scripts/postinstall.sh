#!/usr/bin/env bash

PG_HOST=${PG_HOST:-"localhost"}

set -e

if [ "$OC_ENV" = "ci" ]; then
  echo "Skipping postinstall because OC_ENV is \"ci\""
  exit $?; # exit with return code of previous command
fi

if [ "$SKIP_POSTINSTALL" = "1" ]; then
  echo "Skipping postinstall because SKIP_POSTINSTALL is \"1\""
  exit $?; # exit with return code of previous command
fi

# Only run migrations automatically on staging and production
if [ "$SEQUELIZE_ENV" = "staging" ] || [ "$SEQUELIZE_ENV" = "production" ]; then
  echo "- running db:migrate on $SEQUELIZE_ENV environment"
  npm run db:migrate
  exit $?; # exit with return code of previous command
fi

if command -v psql > /dev/null; then
  echo "✓ PostgreSQL installed"
else
  echo "𐄂 psql command doesn't exist. Make sure you have PostgreSQL installed."
  echo ""
  echo "See: https://github.com/opencollective/opencollective-api/blob/main/docs/postgres.md"
  echo ""
  exit 1
fi
# List databases first, so that a connection/auth failure is not mistaken for a missing database
# (which would trigger db:restore and drop opencollective_dvl). `-w` never prompts for a password.
if DB_LIST=$(psql -w -h $PG_HOST -U postgres -lqt); then
  if echo "$DB_LIST" | cut -d \| -f 1 | grep -qw opencollective_dvl; then
    echo "✓ opencollective_dvl exists"
    ./scripts/db_restore_extensions.sh -d opencollective_dvl -U opencollective -h $PG_HOST
  else
    echo "- restoring opencollective_dvl";
    npm run db:restore
  fi
  echo "- running migration if any"
  PG_DATABASE=opencollective_dvl npm run db:migrate
else
  echo ""
  echo "⚠ Could not list databases on $PG_HOST as user \"postgres\" (see error above)."
  echo "  Skipping database restore and migrations. To fix it, either:"
  echo "  - provide credentials with PGPASSWORD or ~/.pgpass, then run \`npm run postinstall\`"
  echo "  - or skip this step with SKIP_POSTINSTALL=1"
  echo ""
  echo "See: https://github.com/opencollective/opencollective-api/blob/main/docs/postgres.md"
  echo ""
fi

UNAME=$(uname -a)
if [[ $UNAME =~ "Darwin" && $UNAME =~ "arm64" ]]; then
  echo "✓ Running on Apple Silicon (arm64), installing sharp for arm64"
  npm install --os=darwin --cpu=arm64 --ignore-scripts --no-save sharp
fi

echo ""
echo "You can now start the Open Collective API server by running:"
echo "$> npm run dev"
echo ""
