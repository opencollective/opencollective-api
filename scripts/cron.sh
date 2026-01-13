#!/bin/bash
FILE_PATH="./cron/$1/"
TZ=utc

for FILE in `ls $FILE_PATH`; do 
  echo "Running cron job $FILE_PATH$FILE";
  NODE_OPTIONS="-r @sentry/node/preload" npm run script "$FILE_PATH$FILE";
done;
