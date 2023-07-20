#!/bin/bash
FILE_PATH="./cron/$1/"
TZ=utc

for FILE in `ls $FILE_PATH`; do 
  echo "Running $BIN $FILE_PATH$FILE";
  ts-node "$FILE_PATH$FILE";
done;