#!/bin/bash
# Sends Claude Code hook payloads to the spaceterm server via Unix socket.
# Reads JSON from stdin, wraps it with surface ID, and sends via nc.
# Backgrounded to avoid blocking Claude Code.

[ -z "$SPACETERM_SURFACE_ID" ] && exit 0

INPUT=$(cat)

{
  printf '{"type":"hook","surfaceId":"%s","payload":%s}\n' "$SPACETERM_SURFACE_ID" "$INPUT"
} | nc -w 1 -U "${SPACETERM_HOME:-$HOME/.spaceterm}/spaceterm.sock" &

exit 0
