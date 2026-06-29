#!/bin/bash
# Connect to remote Heroku (interactive bash on a one-off dyno)

set -e

usage() {
  echo ""
  echo "Connect to remote Heroku (interactive bash on a one-off dyno)."
  echo ""
  echo "Usage:"
  echo "  $0 staging|prod [--performance]"
  echo ""
  exit 1
}

ENV="$1"
if [ -z "$ENV" ]; then
  usage
fi
shift

PERFORMANCE=false
while [ $# -gt 0 ]; do
  case "$1" in
    --performance)
      PERFORMANCE=true
      ;;
    *)
      echo "Unknown option: $1"
      usage
      ;;
  esac
  shift
done

case "$ENV" in
  staging)
    APP="opencollective-staging-api"
    ;;
  prod)
    APP="opencollective-prod-api"
    ;;
  *)
    echo "Unknown environment: $ENV"
    usage
    ;;
esac

ARGS=(run --app "$APP")
if [ "$PERFORMANCE" = true ]; then
  ARGS+=(-s performance)
fi
ARGS+=(bash)

exec heroku "${ARGS[@]}"
