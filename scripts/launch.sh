#!/usr/bin/env bash
# Smartware MCP server launcher.
#
# This script is what Claude Desktop / Claude Code points at. It:
#   1. Resolves SMARTWARE_DATA_DIR (defaults to ~/smartware-data)
#   2. Loads ANTHROPIC_API_KEY from a sidecar .env file if present (so you
#      don't have to embed the key in claude_desktop_config.json)
#   3. Builds dist/ on first run if it's missing
#   4. Execs the Node server with stdio inherited (MCP transport)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# 1. Data dir
export SMARTWARE_DATA_DIR="${SMARTWARE_DATA_DIR:-${HOME}/smartware-data}"
mkdir -p "${SMARTWARE_DATA_DIR}"

# 2. Optional sidecar .env (project-local secrets, never committed)
if [[ -f "${PROJECT_DIR}/.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "${PROJECT_DIR}/.env"
  set +a
fi

# 3. Build on first run
if [[ ! -f "${PROJECT_DIR}/dist/index.js" ]]; then
  echo "[smartware] dist/ missing — building once…" >&2
  (cd "${PROJECT_DIR}" && npm install --silent && npm run build)
fi

# 4. Launch
exec node "${PROJECT_DIR}/dist/index.js"
