#!/usr/bin/env bash
# Launches the spaceterm MCP server via tsx from the spaceterm node_modules.
# CLAUDE_PLUGIN_ROOT is set by Claude Code and points to src/claude-code-plugin/.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TSX="$PROJECT_ROOT/node_modules/.bin/tsx"

if [ ! -x "$TSX" ]; then
  echo "Error: tsx not found at $TSX" >&2
  exit 1
fi

exec "$TSX" "$SCRIPT_DIR/index.ts"
