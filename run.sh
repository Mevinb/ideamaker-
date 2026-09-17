#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

if ! command -v npm >/dev/null 2>&1; then
  if [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
    source "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  fi
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js and npm are required. Install Node.js 22 or newer, then rerun this script." >&2
  exit 1
fi
if [[ ! -d node_modules/next ]]; then
  npm ci --cache /tmp/ideaarena-npm-cache
fi

echo "Starting IdeaArena at http://127.0.0.1:${PORT:-3000}"
echo "Keep this terminal open; press Ctrl+C to stop."
echo "OmniRoute must be running (start it with: omniroute)."
echo "Gateway settings are read from .env.local, if present."
exec npm run dev -- --hostname 127.0.0.1 --port "${PORT:-3000}"
