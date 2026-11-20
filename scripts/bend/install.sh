#!/bin/sh
# Installs the Bend version this repository is checked with into $BEND_HOME (~/.bend).
#
# The version is pinned, with the sha256 of each release archive, so that CI and
# developers check the laws and compile server/bend/ with the same compiler: the
# compiled files in server/bend/generated/ must not change with the machine.
# To upgrade, take the new version and checksums from https://bend-lang.com/install.sh,
# then run `npm run bend:build` and commit the result.
set -eu

VERSION="2.0.40"
SHA_DARWIN_ARM64="b2be003b041eb6cfc65326be18f79eb2e0bae2189be79a18c507e661b4b6900b"
SHA_DARWIN_X64="9229c8bdd0a93f63fa45cc5af5e9e56389ebb620d655920915daf966c6ca561c"
SHA_LINUX_ARM64="2f42a6fa34ecdaa71ae105e5fa734f9a07e129d333e45448ab6d2ff03a837570"
SHA_LINUX_X64="c9ff8d67bd903fb6ad9a26b43d8a62c01021de82a44d55ce4a3dcd4732113d6b"

fail() {
  printf 'bend install: %s\n' "$*" >&2
  exit 1
}

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) target=darwin-arm64 sum=$SHA_DARWIN_ARM64 ;;
  Darwin-x86_64) target=darwin-x64 sum=$SHA_DARWIN_X64 ;;
  Linux-aarch64 | Linux-arm64) target=linux-arm64 sum=$SHA_LINUX_ARM64 ;;
  Linux-x86_64 | Linux-amd64) target=linux-x64 sum=$SHA_LINUX_X64 ;;
  *) fail "$(uname -s) $(uname -m) is not supported: Bend runs on Linux and macOS, arm64 and x64" ;;
esac

home=${BEND_HOME:-$HOME/.bend}
if [ -x "$home/bin/bend" ] && [ "$(BEND_NO_TELEMETRY=1 "$home/bin/bend" version 2>/dev/null)" = "bend $VERSION" ]; then
  echo "bend $VERSION is already installed at $home"
  exit 0
fi

name="bend-$VERSION-$target.tar.gz"
url="https://github.com/bendlang/bend/releases/download/v$VERSION/$name"
mkdir -p "$home/bin"
tmp=$(mktemp -d "$home/tmp.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

echo "downloading $url"
curl --proto '=https' --tlsv1.2 -fsSL -o "$tmp/$name" "$url" || fail "the download failed: $url"
if command -v sha256sum >/dev/null 2>&1; then
  echo "$sum  $tmp/$name" | sha256sum -c - >/dev/null 2>&1 || fail "$name does not match its pinned sha256; not installed"
else
  echo "$sum  $tmp/$name" | shasum -a 256 -c - >/dev/null 2>&1 || fail "$name does not match its pinned sha256; not installed"
fi

tar -xzf "$tmp/$name" -C "$tmp"
rm -rf "$home/bend2" "$home/guide"
mv "$tmp/bend/bend2" "$tmp/bend/guide" "$home/"
mv -f "$tmp/bend/bin/bend" "$home/bin/bend"
echo "bend $VERSION installed at $home"
