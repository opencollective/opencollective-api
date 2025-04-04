#!/bin/bash
# A wrapper script to run Docker Compose commands

# First, check if standalone docker-compose is installed
if command -v docker-compose &>/dev/null; then
  # Try running docker-compose directly
  if docker-compose version &>/dev/null; then
    docker-compose "$@"
  else
    echo "Docker Compose requires root privileges. Running with sudo: docker-compose $@"
    sudo docker-compose "$@"
  fi
# If standalone not found, check if docker compose plugin is available
elif command -v docker &>/dev/null && docker compose version &>/dev/null; then
  # Docker compose plugin is available
  ./scripts/dev/run-docker.sh compose "$@"
else
  # Neither method is available
  echo "Docker Compose is not installed. See https://docs.docker.com/compose/install/."
  exit 1
fi
