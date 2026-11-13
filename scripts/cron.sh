#!/bin/bash
BIN_PATH=./node_modules/.bin
BIN=babel-node
BIN_OPTIONS="--extensions .js,.ts"
FILE_PATH="./cron/$1/"
TZ=utc

# Jobs keep running when one fails. The failed ones are collected and passed to the next jobs in
# CRON_FAILED_JOBS, so that the last one (e.g. cron/daily/99-done) can report them.
FAILED_JOBS=()

for FILE in `ls $FILE_PATH`; do 
  echo "Running $BIN $FILE_PATH$FILE";
  # Sentry is initialized by the job itself (cron/utils imports server/lib/sentry). The SDK no longer
  # has a preload entry point: since v11, it instruments through diagnostics channels without one.
  if ! CRON_FAILED_JOBS="${FAILED_JOBS[*]}" "$BIN_PATH/$BIN" ${BIN_OPTIONS} "$FILE_PATH$FILE"; then
    FAILED_JOBS+=("${FILE%.*}")
  fi
done;

if [ ${#FAILED_JOBS[@]} -gt 0 ]; then
  echo "Failed jobs: ${FAILED_JOBS[*]}";
  exit 1;
fi
