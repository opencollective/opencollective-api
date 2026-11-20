#!/bin/sh
# Checks the laws or compiles the Bend code, with the pinned Bend (see install.sh).
#
#   scripts/bend/run.sh check   proves every law in LAWS.bend against server/bend/
#   scripts/bend/run.sh build   compiles server/bend/*.bend to server/bend/generated/*.mjs
set -eu

cd "$(dirname "$0")/../.."

# Bend otherwise asks bend-lang.com once a day whether a newer version exists
export BEND_NO_TELEMETRY=1

bend="${BEND_HOME:-$HOME/.bend}/bin/bend"
if [ ! -x "$bend" ]; then
  echo "Bend is not installed: run scripts/bend/install.sh" >&2
  exit 1
fi

case "${1:-}" in
  check)
    # Prints ALL PROOFS CHECK and exits 0 only when every law has a valid proof
    "$bend" PROOF.bend
    ;;
  build)
    for source in server/bend/*.bend; do
      "$bend" "$source" -o "server/bend/generated/$(basename "$source" .bend).mjs"
    done
    ;;
  *)
    echo "usage: $0 check|build" >&2
    exit 1
    ;;
esac
