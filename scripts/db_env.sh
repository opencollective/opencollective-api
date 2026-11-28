#!/bin/sh
# Shared helper for the blank database scripts. Meant to be sourced (`. ./scripts/db_env.sh`), not executed.
#
# Resolves the target database, host and environment: values already set in the environment win,
# then the ones from the .env file (override the path with $ENV_FILE), like with dotenv.

ENV_FILE=${ENV_FILE:-.env}

# Reads a single variable from the env file without sourcing it (values may not be shell-safe).
# Like dotenv: a quoted value is taken as is (a `#` inside it is kept), an unquoted one stops at the first `#`.
load_from_env_file() {
  name="$1"
  eval "current=\${$name}"
  if [ -n "$current" ] || [ ! -f "$ENV_FILE" ]; then return; fi
  value=$(grep -E "^[[:space:]]*(export[[:space:]]+)?$name=" "$ENV_FILE" | tail -n 1 | sed -E "s/^[^=]*=//; s/^[[:space:]]*//")
  case "$value" in
    \"*) value=$(printf '%s' "$value" | sed -E 's/^"([^"]*)".*$/\1/') ;;
    \'*) value=$(printf '%s' "$value" | sed -E "s/^'([^']*)'.*\$/\\1/") ;;
    *) value=$(printf '%s' "$value" | sed -E 's/#.*$//; s/[[:space:]]*$//') ;;
  esac
  if [ -n "$value" ]; then
    export "$name=$value"
  fi
}

load_from_env_file PG_DATABASE
load_from_env_file PG_HOST
load_from_env_file OC_ENV

DEFAULT_BLANK_DB=opencollective_blank
