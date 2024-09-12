#!/bin/bash
# This script:
# 1. Checks if mailpit is installed and installs it if it is not
# 2. Starts mailpit
#
# Usage: ./run-mailpit.sh

set -e

VERSION=v1.20.4
GH_REPO="axllent/mailpit"
TIMEOUT=90
BIN_PATH="./scripts/dev/bin/mailpit@$VERSION"

# A function to download mailpit, forked from https://raw.githubusercontent.com/axllent/mailpit/develop/install.sh to allow setting the version
install_mailpit() {
  # detect the platform
  OS="$(uname)"
  case $OS in
  Linux)
    OS='linux'
    ;;
  FreeBSD)
    OS='freebsd'
    echo 'OS not supported'
    exit 2
    ;;
  NetBSD)
    OS='netbsd'
    echo 'OS not supported'
    exit 2
    ;;
  OpenBSD)
    OS='openbsd'
    echo 'OS not supported'
    exit 2
    ;;
  Darwin)
    OS='darwin'
    ;;
  SunOS)
    OS='solaris'
    echo 'OS not supported'
    exit 2
    ;;
  *)
    echo 'OS not supported'
    exit 2
    ;;
  esac

  # detect the arch
  OS_type="$(uname -m)"
  case "$OS_type" in
  x86_64 | amd64)
    OS_type='amd64'
    ;;
  i?86 | x86)
    OS_type='386'
    ;;
  aarch64 | arm64)
    OS_type='arm64'
    ;;
  *)
    echo 'OS type not supported'
    exit 2
    ;;
  esac

  GH_REPO_BIN="mailpit-${OS}-${OS_type}.tar.gz"

  #create tmp directory and move to it with macOS compatibility fallback
  tmp_dir=$(mktemp -d 2>/dev/null || mktemp -d -t 'mailpit-install.XXXXXXXXXX')
  cd "$tmp_dir"

  echo "Downloading Mailpit $VERSION"
  LINK="https://github.com/${GH_REPO}/releases/download/${VERSION}/${GH_REPO_BIN}"

  curl --silent --location --max-time "${TIMEOUT}" "${LINK}" | tar zxf - || {
    echo "Error downloading"
    exit 2
  }

  # Go back to the project dir and copy the binary
  cd - >/dev/null || exit
  mkdir -p "./scripts/dev/bin"
  rm -f ./scripts/dev/bin/mailpit@* # Remove any existing mailpit binaries
  cp "$tmp_dir/mailpit" $BIN_PATH
  rm -rf "$tmp_dir"
  echo "Installed successfully to ./scripts/dev/bin/mailpit"
}

# Check if mailpit is downloaded in the bin folder
if [ ! -f $BIN_PATH ]; then
  echo "mailpit could not be found. Installing..."

  # Fail if env is Windows
  if [[ "$OSTYPE" == "msys" ]]; then
    echo "Automatic installation of mailpit is not supported on Windows, please [install it manually](https://github.com/axllent/mailpit)."
    echo "Feel free to contribute a PR to add support for this!"
    exit 1
  fi

  # Install mailpit (works on Linux and MacOS)
  install_mailpit
fi

# Start mailpit
$BIN_PATH --listen localhost:1080 --smtp localhost:1025
