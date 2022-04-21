#!/bin/bash

echo "> Starting api server"
if [ -z "$API_FOLDER" ]; then
  cd ~/api
else
  cd $API_FOLDER
fi

PG_DATABASE=opencollective_dvl MAILDEV_CLIENT=false npm run start:e2e:server &
API_PID=$!
cd -

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

echo ""
wait_for_service API 127.0.0.1 3060

echo ""
echo "> Running artillery tests"

npx artillery run test/performance/*.yml --output output/report.json

RETURN_CODE=$?
if [ $RETURN_CODE -ne 0 ]; then
  echo "Error with artillery tests, exiting"
  exit 1;
fi
echo ""

echo "Killing all node processes"
kill $API_PID;

echo "Exiting with code $RETURN_CODE"
exit $RETURN_CODE
