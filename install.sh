#!/usr/bin/env bash
set -euo pipefail

PACKAGE_SPEC="${OMNIX_GO_NPM_SPEC:-omnix-go}"
INSTALL_PREFIX="${OMNIX_GO_PREFIX:-$HOME/.local}"
RUNTIME_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/omnix-go/runtime"

node_is_usable() {
  command -v node >/dev/null 2>&1 &&
    [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -ge 20 ]
}

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

install_portable_node() {
  case "$(uname -s)" in
    Darwin) node_os="darwin" ;;
    Linux) node_os="linux" ;;
    *) echo "Use install.ps1 on Windows; unsupported platform: $(uname -s)" >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) node_arch="x64" ;;
    arm64|aarch64) node_arch="arm64" ;;
    *) echo "Unsupported CPU architecture: $(uname -m)" >&2; exit 1 ;;
  esac

  mkdir -p "$RUNTIME_ROOT"
  checksum_list="$RUNTIME_ROOT/SHASUMS256.txt"
  curl --fail --silent --show-error --location \
    "https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt" -o "$checksum_list"
  archive_name="$(awk -v suffix="-$node_os-$node_arch.tar.gz" '$2 ~ suffix "$" { print $2; exit }' "$checksum_list")"
  expected="$(awk -v name="$archive_name" '$2 == name { print $1; exit }' "$checksum_list")"
  if [ -z "$archive_name" ] || [ -z "$expected" ]; then
    echo "Could not resolve the official Node.js runtime archive." >&2
    exit 1
  fi
  archive="$RUNTIME_ROOT/$archive_name"
  curl --fail --silent --show-error --location \
    "https://nodejs.org/dist/latest-v24.x/$archive_name" -o "$archive"
  actual="$(sha256_file "$archive")"
  if [ "$actual" != "$expected" ]; then
    echo "Node.js runtime checksum verification failed." >&2
    exit 1
  fi
  rm -rf "$RUNTIME_ROOT/node" "$RUNTIME_ROOT/extract"
  mkdir -p "$RUNTIME_ROOT/extract"
  tar -xzf "$archive" -C "$RUNTIME_ROOT/extract"
  extracted="$(find "$RUNTIME_ROOT/extract" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  mv "$extracted" "$RUNTIME_ROOT/node"
  rm -rf "$RUNTIME_ROOT/extract" "$archive" "$checksum_list"
  export PATH="$RUNTIME_ROOT/node/bin:$PATH"
}

if ! node_is_usable; then
  echo "Installing a verified private Node.js runtime for OmniX Go…"
  install_portable_node
fi

mkdir -p "$INSTALL_PREFIX"
npm install --global --prefix "$INSTALL_PREFIX" "$PACKAGE_SPEC"
"$INSTALL_PREFIX/bin/omnix-go" service install --tunnel auto --workspace "$HOME"

echo
echo "OmniX Go is installed with its verified gateway runtime and per-user login service."
echo "Provision your permanent endpoint with: omnix-go gateway provision --name <name>"
echo "Command: $INSTALL_PREFIX/bin/omnix-go"
if [[ ":$PATH:" != *":$INSTALL_PREFIX/bin:"* ]]; then
  echo "Add this once to your shell profile: export PATH=\"$INSTALL_PREFIX/bin:\$PATH\""
fi
echo "Run: omnix-go"
