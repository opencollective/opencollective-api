#!/usr/bin/env bash
set -e

if [ -z "$SENTRY_PROJECT" ]; then
  echo "SENTRY_PROJECT environment variable is not set. Ignoring..."
  exit 0
fi

if [ -z "$HEROKU_SLUG_COMMIT" ]; then
  RELEASE=$(git rev-parse HEAD)
else
  RELEASE=$HEROKU_SLUG_COMMIT
fi

echo "Injecting source maps for release $RELEASE..."
sentry-cli sourcemaps inject --org $SENTRY_ORG --project $SENTRY_PROJECT ./dist

echo "Uploading source maps for release $RELEASE..."
sentry-cli sourcemaps upload --org $SENTRY_ORG --project $SENTRY_PROJECT --release=$RELEASE ./dist
