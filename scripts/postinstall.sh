#!/usr/bin/env bash

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
  pnpm db:migrate
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
if psql -lqt | cut -d \| -f 1 | grep -qw opencollective_dvl; then
  echo "✓ opencollective_dvl exists"
else
  echo "- restoring opencollective_dvl";
  pnpm db:restore
fi
echo "- running migration if any"
PG_DATABASE=opencollective_dvl pnpm db:migrate

echo ""
echo "You can now start the Open Collective API server by running:"
echo "$> pnpm dev"
echo ""
