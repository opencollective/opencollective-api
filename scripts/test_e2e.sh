#!/usr/bin/env bash

main() {
  # exit script if any error occurs
  set -e

  # cleanup upon interruption, termination or exit
  trap 'echo "Received INT signal"; finish 2' INT
  trap 'echo "Received TERM signal"; finish 15' TERM
  trap 'echo "Received EXIT signal"; finish $?' EXIT

  checkParameters $@
  setCommonEnvironment
  cleanup

  for STEP in $@; do
    echo "Running step $STEP"
    parseStep
    setRepoDir

    if [ "$REPO_NAME" = "api" ]; then
      setPgDatabase
    fi

    if [ "$PHASE" = "install" ]; then
      install
    elif [ "$PHASE" = "run" ]; then
      run
    elif [ "$PHASE" = "testE2E" ]; then
      testE2E
    fi
  done
}

cleanup() {
  echo "Cleaning up node processes"
  #pkill -f node selenium chromedriver Chrome
  pkill node || true
}

finish() {
  # can't rely on $? because of the sleep command running in parallel with spawned jobs
  EXIT_CODE=$1
  trap '' INT TERM EXIT
  cleanup
  echo "Finished with exit code $EXIT_CODE."
  exit ${EXIT_CODE}
}

checkParameters() {
  if [ $# -eq 0 ]; then
    usage
  fi
  for STEP in $@; do
    parseStep
  done
}

parseStep() {
  REPO_NAME=$(echo ${STEP} | sed 's/:.*//')
  PHASE=$(echo ${STEP} | sed 's/.*://')
  if ( [ "$REPO_NAME" != "api" ] && [ "$REPO_NAME" != "website" ] && [ "$REPO_NAME" != "app" ] ) ||
     ( [ "$PHASE" != "install" ] && [ "$PHASE" != "run" ] && [ "$PHASE" != "testE2E" ] ) ||
     ( [ "$REPO_NAME" = "api" ] && [ "$PHASE" = "testE2E" ] ); then    echo "Unrecognized step $STEP"
    usage 1;
  fi
}

setOutputDir() {
  if [ "$NODE_ENV" = "circleci" ]; then
    OUTPUT_DIR="${CIRCLE_ARTIFACTS}/e2e"
  else
    OUTPUT_DIR="${LOCAL_DIR}/test/output/e2e"
  fi
  #OUTPUT_DIR=${OUTPUT_DIR}/$(date "+%Y%m%d_%H%M%S")
  mkdir -p ${OUTPUT_DIR}
  echo "Output directory set to $OUTPUT_DIR"
}

setCommonEnvironment() {
  LOCAL_DIR=$PWD
  LOCAL_NAME=$(basename ${LOCAL_DIR})
  if [ -f "${LOCAL_DIR}/.env" ]; then
    source ${LOCAL_DIR}/.env
  fi
  if [ -z "${NODE_ENV}" ]; then
    NODE_ENV=development
  fi
  setOutputDir
}

usage() {
  CMD=test_e2e.sh
  echo " "
  echo "Usage: $CMD <repo>:<phase> [<repo>:<phase> ... <repo>:<phase>]"
  echo " "
  echo "  <repo>:  api, website or app"
  echo "  <phase>: install, run or testE2E. testE2E not applicable to api."
  echo " "
  echo "E.g : $CMD api:run website:install website:run"
  echo " "
  exit $1;
}

setRepoDir() {
  if [ ${REPO_NAME} = ${LOCAL_NAME} ]; then
    REPO_DIR=${LOCAL_DIR}
  else
    if [ "$NODE_ENV" = "development" ]; then
      REPO_DIR_VAR_NAME=$(echo ${REPO_NAME} | awk '{print toupper($0)}')_DIR
      if [ ! -d "${!REPO_DIR_VAR_NAME}" ]; then
        echo "$REPO_DIR_VAR_NAME not configured in .env"
        exit 1
      fi
      REPO_DIR=${!REPO_DIR_VAR_NAME}
    else
      REPO_DIR="$HOME/$REPO_NAME"
    fi
  fi
}

install() {
  if [ -d ${REPO_DIR} ]; then
    echo "$REPO_NAME already checked out to $REPO_DIR"
  else
    echo "Checking out $REPO_NAME into $REPO_DIR"
    # use Github SVN export to avoid fetching git history, faster
    REPO_SVN=https://github.com/OpenCollective/${REPO_NAME}/trunk
    svn export ${REPO_SVN} ${REPO_DIR}
  fi
  cd ${REPO_DIR}
  echo "Performing NPM install"
  START=$(date +%s)
  npm install
  END=$(date +%s)
  echo "Executed NPM install in $(($END - $START)) seconds"
  linkRepoNmToCache
}

linkRepoNmToCache() {
  REPO_NM="${REPO_DIR}/node_modules/"
  CACHE_DIR="${HOME}/cache/"
  [ -d ${CACHE_DIR} ] || mkdir ${CACHE_DIR}
  REPO_NM_CACHE="${CACHE_DIR}/${REPO_NAME}_node_modules"
  echo "Linking ${REPO_NM_CACHE} -> ${REPO_NM}"
  ln -s ${REPO_NM} ${REPO_NM_CACHE}
}

setPgDatabase() {
  if [ "$NODE_ENV" = "development" ]; then
    # don't screw up developer's opencollective_localhost
    echo "setting PG_DATABASE=opencollective_test"
    export PG_DATABASE=opencollective_test
  fi
}

runProcess() {
  cd ${REPO_DIR}
  LOG_FILE="$OUTPUT_DIR/$REPO_NAME.log"
  PARENT=$$
  # in case spawned process exits unexpectedly, kill parent process and its sub-processes (via the trap)
  sh -c "npm start | tee $LOG_FILE 2>&1;
         kill $PARENT 2>/dev/null" &
  echo "Started $REPO_NAME with PID $! and saving output to $LOG_FILE"
  # TODO should somehow detect when process is ready instead of fragile hard-coded delay
  if [ "$NODE_ENV" = "development" ]; then
    DELAY=5
  else
    DELAY=40
  fi
  echo "Waiting for $REPO_NAME startup during $DELAY seconds"
  # Wait for startup. Break down sleep into pieces to allow prospective kill signals to get trapped.
  for i in $(seq ${DELAY}); do sleep 1; done
  echo "Waited for $REPO_NAME startup during $DELAY seconds"
}

run() {
  if [ ! -d ${REPO_DIR} ]; then
    echo "${REPO_NAME} not installed in ${REPO_DIR}, exiting."
    exit 1;
  else
    runProcess
  fi
}

testE2E() {
  echo "Starting ${REPO_NAME} E2E tests"
  cd ${REPO_DIR}
  npm run nightwatch
  echo "Finished ${REPO_NAME} E2E tests"
}

main $@