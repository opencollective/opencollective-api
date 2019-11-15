#!/bin/bash
set -e

setupScriptRan=false

installNodeModules() {
  echo "Installing node modules"
  npm install
}
waitForPostgresToByReady() {
  # Code by https://starkandwayne.com/blog/how-to-know-when-your-postgres-service-is-ready/
  until pg_isready
  do
    echo "Waiting for postgres"
    sleep 2;
  done
}
seedDB() {
  echo "Seeding database"
  waitForPostgresToByReady
  npm run postinstall
}
doesDatabaseExists() {
  # Code by https://stackoverflow.com/a/16783253/5801753
  if psql -lqt | cut -d \| -f 1 | grep -qw $1; then
    return 0
  else
    return 1
  fi
}
setupTestingDB() {
  echo "Setting up testing db"
  waitForPostgresToByReady
  if ! doesDatabaseExists "opencollective_test"; then
    npm run db:setup
    createdb opencollective_test || true
    psql -d opencollective_test -c 'GRANT ALL PRIVILEGES ON DATABASE opencollective_test TO opencollective' || true
    psql -d opencollective_test -c 'CREATE EXTENSION postgis' || true
    psql -d opencollective_test -c 'ALTER USER opencollective WITH SUPERUSER;' || true
  fi
}
setupEnvironmentIfNodeModulesDoesNotExists() {
  if [ ! -d node_modules ]; then
    setupScriptRan=true
    installNodeModules
    seedDB
  fi
}

case $1 in
  'start')
    echo "Starting in default mode"
    setupEnvironmentIfNodeModulesDoesNotExists
    npm run build
    exec npm run start
    ;;
  'dev')
    echo "Starting in dev mode"
    setupEnvironmentIfNodeModulesDoesNotExists
    exec npm run dev
    ;;
  'e2e')
    echo "Starting in e2e mode"
    setupEnvironmentIfNodeModulesDoesNotExists
    if ! $setupScriptRan; then
      waitForPostgresToByReady
      npm run db:restore && npm run db:migrate
    fi
    TZ=UTC NODE_ENV=e2e E2E_TEST=1 exec npm run start
    ;;
  'test')
    echo "Starting in test mode"
    setupEnvironmentIfNodeModulesDoesNotExists
    setupTestingDB
    exec npm run test
    ;;
  *)
    exec "$@"
    ;;
esac
