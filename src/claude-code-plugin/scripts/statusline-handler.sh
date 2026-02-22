#!/bin/bash
# Sends Claude Code status line data to the spaceterm server via Unix socket.
# Reads JSON from stdin, wraps it with surface ID, and sends via nc.
# Outputs nothing to stdout (Claude Code displays empty status line).

[ -z "$SPACETERM_SURFACE_ID" ] && exit 0

INPUT=$(cat)

{
  printf '{"type":"status-line","surfaceId":"%s","payload":%s}\n' "$SPACETERM_SURFACE_ID" "$INPUT"
} | nc -w 1 -U "${SPACETERM_HOME:-$HOME/.spaceterm}/hooks.sock" >/dev/null 2>&1 &

exit 0
