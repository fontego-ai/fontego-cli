#!/bin/sh
# Installs fontego on Linux or macOS: downloads the executable for this system from the project's releases, checks
# its SHA-256 against the release's SHA256SUMS, and puts it in ~/.local/bin. It never asks for sudo.
#
#   curl -fsSL https://fontego.ai/install.sh | sh
#
# FONTEGO_VERSION       a version (0.2.0), or latest (the default)
# FONTEGO_INSTALL_DIR   where to put it (default ~/.local/bin)
# FONTEGO_DOWNLOAD_URL  where the releases are (default https://github.com/fontego-ai/fontego-cli/releases)
#
# On Windows: npm i -g fontego, or the .exe from the releases page.

set -eu

releases="${FONTEGO_DOWNLOAD_URL:-https://github.com/fontego-ai/fontego-cli/releases}"
version="${FONTEGO_VERSION:-latest}"
dir="${FONTEGO_INSTALL_DIR:-$HOME/.local/bin}"

fail() {
  echo "error: $1" >&2
  [ $# -gt 1 ] && echo "hint: $2" >&2
  exit 1
}

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "this script is for Linux and macOS" "on Windows: npm i -g fontego, or the .exe from $releases" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "no fontego for $(uname -m) yet" "npm i -g fontego says if there is one" ;;
esac
# A shell under Rosetta says x86_64 on an Apple Silicon Mac: take the native one.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
  arch=arm64
fi

if [ "$version" = latest ]; then
  base="$releases/latest/download"
else
  base="$releases/download/v${version#v}"
fi
file="fontego-$os-$arch"

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    fail "this needs curl or wget"
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    fail "this needs sha256sum or shasum to check the download"
  fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

echo "Downloading fontego ($version, $os $arch)…"
download "$base/$file" "$tmp/$file" || fail "couldn't download $base/$file" "check the version, or try again later"
download "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail "couldn't download $base/SHA256SUMS"

expected="$(awk -v f="$file" '$2 == f { print $1 }' "$tmp/SHA256SUMS")"
[ -n "$expected" ] || fail "$file isn't in the release's SHA256SUMS"
[ "$(sha256 "$tmp/$file")" = "$expected" ] || fail "the download doesn't match its SHA-256" "nothing was installed; try again"

mkdir -p "$dir"
chmod 755 "$tmp/$file"
mv "$tmp/$file" "$dir/fontego"

echo "Installed fontego $("$dir/fontego" version) in $dir/fontego"
case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "Add $dir to your PATH, for example: echo 'export PATH=\"$dir:\$PATH\"' >> ~/.profile" ;;
esac
echo
echo "Next:"
echo "  fontego login https://your-fontego.example   # the address you open in the browser"
echo "  fontego setup                                # teach the AI agents on this machine to use fontego"
