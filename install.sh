#!/usr/bin/env bash
set -euo pipefail

PACKAGE_SPEC="${CHATGPT_CODE_NPM_SPEC:-chatgpt-code}"

if ! command -v node >/dev/null 2>&1; then
  echo "ChatGPT Code requires Node.js 20 or newer." >&2
  echo "Install it from https://nodejs.org or with: brew install node" >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js 20 or newer is required; found $(node --version)." >&2
  exit 1
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    brew install cloudflared
  else
    echo "cloudflared is optional but required for public HTTPS." >&2
  fi
fi

npm install --global "$PACKAGE_SPEC"
echo
echo "Installed ChatGPT Code. Run:"
echo "  chatgpt-code doctor"
echo "  chatgpt-code"
