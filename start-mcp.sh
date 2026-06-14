#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Starting Muibook MCP server..." >&2
cd "$SCRIPT_DIR"
exec node mcp-server.js
