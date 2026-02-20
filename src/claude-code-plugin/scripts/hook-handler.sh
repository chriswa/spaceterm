#!/bin/bash
# Sends Claude Code hook payloads to the spaceterm server via Unix socket.
# Reads JSON from stdin, wraps it with surface ID, and sends via nc.
# Backgrounded to avoid blocking Claude Code.

[ -z "$SPACETERM_SURFACE_ID" ] && exit 0

SOCKET="${SPACETERM_HOME:-$HOME/.spaceterm}/spaceterm.sock"
FAILURE_LOG="${SPACETERM_HOME:-$HOME/.spaceterm}/hook-failures.log"

INPUT=$(cat)
TS=$(perl -MTime::HiRes=time -e 'printf "%d",time*1000')
# Note: $() strips trailing newlines, so we use printf '%s\n' when sending
MSG=$(printf '{"type":"hook","surfaceId":"%s","ts":%s,"payload":%s}' "$SPACETERM_SURFACE_ID" "$TS" "$INPUT")

{
  for attempt in 1 2 3; do
    printf '%s\n' "$MSG" | nc -w 1 -U "$SOCKET" && exit 0
    [ "$attempt" -lt 3 ] && sleep 0.3
  done
  # All retries exhausted — log failure
  HOOK_TYPE=$(printf '%s' "$INPUT" | grep -o '"event":"[^"]*"' | head -1 | cut -d'"' -f4)
  printf '{"ts":"%s","hookType":"%s","surfaceId":"%s","error":"all 3 delivery attempts failed"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "${HOOK_TYPE:-unknown}" \
    "$SPACETERM_SURFACE_ID" \
    >> "$FAILURE_LOG"
} &

exit 0
