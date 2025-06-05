#!/bin/bash
# A wrapper script to run Docker Compose or Podman Compose commands

if command -v podman-compose &>/dev/null; then
    podman-compose "$@"
elif command -v docker-compose &>/dev/null; then
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
  # No compose tool is available
  echo "Neither Podman Compose nor Docker Compose is installed."
  echo "See https://github.com/containers/podman-compose#installation or https://docs.docker.com/compose/install/"
  exit 1
fi
