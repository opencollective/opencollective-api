#!/usr/bin/env bash
# Ensure schemas are up to date

# Ensure we are on root folder
cd -- "$(dirname $0)/.."

pnpm dev &
API_PID=$!

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
pnpm graphql:update || exit 1

# Check if files changed
CHANGED=$(git status --porcelain | grep lang)
if [ -n "${CHANGED}" ] ; then
  echo "GraphQL schema files are not up to date, Please run 'pnpm graphql:update' with the API started"
  echo "-------- FILES --------"
  git status
  echo "-------- DIFF --------"
  git --no-pager diff
  kill $API_PID;
  exit 1
else
  kill $API_PID;
  echo "Eveything's up to date 🌞️"
fi
