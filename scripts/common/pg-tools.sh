# Postgres client tools for the db_* scripts. Source it, then call `pg_tool <command> [args...]`.
#
# pg_dump and pg_restore must match the server's major version: newer ones emit settings an older
# server rejects (e.g. `SET transaction_timeout` from 18 on 16). When the local tools don't match,
# are missing, or USE_DOCKER / USE_PODMAN is set, they run from the postgres:<server major> image.
# Files are passed through stdin/stdout so the container needs no volume.

PG_HOST=${PG_HOST:-"localhost"}

pg_major() {
  "$@" --version 2>/dev/null | sed -E 's/^[^0-9]*([0-9]+).*/\1/'
}

PG_SERVER_MAJOR=$(psql -h "$PG_HOST" -U postgres -d postgres -tAc "SELECT current_setting('server_version_num')::int / 10000" 2>/dev/null)
PG_TOOLS_MAJOR=$(pg_major pg_restore)
PG_TOOLS_CONTAINER=""

if [ "$USE_DOCKER" = "true" ]; then
  PG_TOOLS_CONTAINER="./scripts/dev/run-docker.sh"
elif [ "$USE_PODMAN" = "true" ]; then
  PG_TOOLS_CONTAINER="podman"
elif [ -z "$PG_TOOLS_MAJOR" ] || { [ -n "$PG_SERVER_MAJOR" ] && [ "$PG_TOOLS_MAJOR" != "$PG_SERVER_MAJOR" ]; }; then
  if command -v docker >/dev/null; then
    PG_TOOLS_CONTAINER="./scripts/dev/run-docker.sh"
  elif command -v podman >/dev/null; then
    PG_TOOLS_CONTAINER="podman"
  else
    echo "Postgres client tools ${PG_TOOLS_MAJOR:-(missing)} don't match the server (${PG_SERVER_MAJOR}), and neither docker nor podman is available." >&2
    echo "Install the client tools for version ${PG_SERVER_MAJOR} (e.g. brew install postgresql@${PG_SERVER_MAJOR})." >&2
    exit 1
  fi
fi

if [ -n "$PG_TOOLS_CONTAINER" ]; then
  PG_TOOLS_IMAGE="postgres:${PG_SERVER_MAJOR:-16}"
  echo "Running Postgres client tools from $PG_TOOLS_IMAGE"
fi

pg_tool() {
  if [ -n "$PG_TOOLS_CONTAINER" ]; then
    $PG_TOOLS_CONTAINER run --rm -i --network host "$PG_TOOLS_IMAGE" "$@"
  else
    "$@"
  fi
}
