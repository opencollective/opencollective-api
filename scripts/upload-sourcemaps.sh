#!/usr/bin/env bash
set -e

if [ -z "$SENTRY_PROJECT" ]; then
  echo "SENTRY_PROJECT environment variable is not set. Ignoring..."
  exit 0
fi

if ! [ -z "$SOURCE_VERSION" ]; then
  RELEASE=$SOURCE_VERSION
elif ! [ -z "$HEROKU_SLUG_COMMIT" ]; then
  RELEASE=$HEROKU_SLUG_COMMIT
# Fallback for when running locally. Remember that this breaks Heroku since git is available but the build folder does not contain the .git folder.
elif [ -x "$(command -v git)" ]; then
  RELEASE=$(git rev-parse HEAD)
fi


if [ -z "$HEROKU_SLUG_COMMIT" ]; then
  echo "Could not determine release version. Please set the SENTRY_RELEASE environment variable or ensure that git is available. Ignoring..."
  exit 0
fi

echo "Injecting source maps for release $RELEASE..."
sentry-cli sourcemaps inject --org $SENTRY_ORG --project $SENTRY_PROJECT ./dist

echo "Uploading source maps for release $RELEASE..."
sentry-cli sourcemaps upload --org $SENTRY_ORG --project $SENTRY_PROJECT --release=$RELEASE ./dist
