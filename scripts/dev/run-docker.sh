#!/bin/bash
# A wrapper script to run Docker/Podman commands

# Check for podman first
if command -v podman &>/dev/null; then
    podman "$@"
elif ! command -v docker &>/dev/null; then
  echo "Neither Podman nor Docker is installed. See https://podman.io/getting-started/installation or https://docs.docker.com/engine/install/."
  exit 1
elif docker info &>/dev/null; then
  docker "$@"
else
  echo "Docker requires root privileges. Running with sudo: docker $@"
  sudo docker "$@"
fi
