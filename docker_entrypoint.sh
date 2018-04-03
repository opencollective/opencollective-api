#!/bin/bash

echo "Executing migrations..."
# wait for Postgres
sleep 10
until npm run db:migrate; do
  >&2 echo "Postgres is unavailable - sleeping"
  sleep 5
done

echo "Executing process..."
exec "$@"
