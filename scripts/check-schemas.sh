#!/usr/bin/env bash
# Ensure schemas are up to date

# Ensure we are on root folder
cd -- "$(dirname $0)/.."

# Start the API in its own process group so the whole tree (npm, nodemon, babel-node) can be stopped on exit.
# Killing only the npm PID leaves the server running and holding the output pipe, which makes `turbo run schema:check` hang.
set -m
npm run dev:task &
API_PID=$!
set +m
trap 'kill -- -"$API_PID" 2>/dev/null || true' EXIT

# Wait for a service to be up
function wait_for_service() {
  echo "> Waiting for $1 to be ready... "
  while true; do
    nc -z "$2" "$3"
    EXIT_CODE=$?
    if [ $EXIT_CODE -eq 0 ]; then
      echo "> Application $1 is up!"
      break
    fi
    sleep 1
  done
}

wait_for_service API 127.0.0.1 3060

# Build schema files
npm run graphql:updateV1 && npm run graphql:updateV2 || exit 1

# Check if files changed
CHANGED=$(git status --porcelain -- server/graphql/schemaV1.graphql server/graphql/schemaV2.graphql)
if [ -n "${CHANGED}" ] ; then
  echo "GraphQL schema files are not up to date, Please run 'npm run graphql:update' with the API started"
  echo "-------- FILES --------"
  git status
  echo "-------- DIFF --------"
  git --no-pager diff
  exit 1
else
  echo "Eveything's up to date 🌞️"
fi
