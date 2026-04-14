#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${1:-3008}"

cd "$PROJECT_DIR"

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install --legacy-peer-deps
fi

echo "Starting app at http://127.0.0.1:${PORT}"
WATCHPACK_POLLING=true npm run dev -- --hostname 127.0.0.1 --port "$PORT"
