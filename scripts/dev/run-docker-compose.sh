#!/bin/bash
# A wrapper script to run Docker Compose commands

# Reverse condition: just exit if docker not installed
if ! command -v docker-compose &>/dev/null; then
  echo "Docker Compose is not installed. See https://docs.docker.com/compose/install/."
  exit 1
fi

if docker-compose version &>/dev/null; then
  docker-compose "$@"
else
  echo "Docker Compose requires root privileges. Running with sudo: docker $@"
  sudo docker-compose "$@"
fi
