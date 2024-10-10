#!/bin/bash
# A wrapper script to run Docker commands

# Reverse condition: just exit if docker not installed
if ! command -v docker &>/dev/null; then
  echo "Docker is not installed. See https://docs.docker.com/engine/install/."
  exit 1
fi

if docker info &>/dev/null; then
  docker $@
else
  echo "Docker requires root privileges. Running with sudo..."
  sudo docker $@
fi
