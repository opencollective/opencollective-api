#!/bin/bash

set -e

usage() {
  echo ""
  echo "This script creates an encrypted backup of our Heroku DBs and environment variables."
  echo "You can also use this to decrypt and inflate files with the 'restore' command."
  echo ""
  echo "Usage:";
  echo "       backup.sh backup";
  echo "       backup.sh restore file";
  echo ""
  exit 0;
}

ACTION="$1"
FILE="$2"
if [ -z "$ACTION" ]; then usage; fi;

DATE=$(date +"%Y-%m-%d")
mkdir -p dbdumps/$DATE

if [[ -z "${ENCRYPTION_KEY}" ]]; then
    echo "You must specify the ENCRYPTION_KEY environment variable"
    exit 0
fi

if [ "$ACTION" = "backup" ]; then
    # Backup Environment Variables
    echo "Backing up environment variables..."
    heroku config -s -a opencollective-prod-api > dbdumps/$DATE/api.env
    heroku config -s -a oc-prod-frontend > dbdumps/$DATE/frontend.env
    heroku config -s -a opencollective-metabase > dbdumps/$DATE/metabase.env

    # Download latest DB backup dump
    echo "Backing up production database..."
    heroku pg:backups:download -a opencollective-prod-api
    mv latest.dump dbdumps/$DATE/prod.db.dump

    # Download Metabase DB backup dump
    echo "Backing up metabase database..."
    heroku pg:backups:download -a opencollective-metabase
    mv latest.dump dbdumps/$DATE/metabase.dump

    echo "Compacting Backup..."
    tar -cf dbdumps/$DATE.tar dbdumps/$DATE
    gzip dbdumps/$DATE.tar

    echo "Encrypting Backup..."
    openssl enc -aes-256-cbc -k $ENCRYPTION_KEY -a -salt -iter 5 -in dbdumps/$DATE.tar.gz -out dbdumps/$DATE.tar.gz.enc
    rm -r dbdumps/$DATE.tar.gz dbdumps/$DATE

    echo "Done."
elif [ "$ACTION" = "restore" ]; then
    if [[ -z "${FILE}" ]]; then
        echo "You must specify the file to restore"
        exit 0
    fi

    echo "Decrypting Backup..."
    openssl aes-256-cbc -d -k $ENCRYPTION_KEY -a -iter 5 -in $FILE -out tmpdata.tar.gz
    echo "Inflating Backup..."
    tar -xzf tmpdata.tar.gz
    rm -f tmpdata.tar.gz
    echo "Done."
else
    usage
fi