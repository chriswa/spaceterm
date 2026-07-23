#!/bin/bash
# Cursor CLI statusLine command — forwards context_window telemetry to Spaceterm.
# Configured via ~/.cursor/cli-config.json by prepareCursorAgentPluginDir.
# When SPACETERM_SURFACE_ID is unset (plain `agent` outside Spaceterm), optionally
# runs the user's previous statusLine command from cursor-statusline-passthrough.json.

INPUT=$(cat)

SOCKET="${SPACETERM_HOME:-$HOME/.spaceterm}/hooks.sock"
PASSTHROUGH="${SPACETERM_HOME:-$HOME/.spaceterm}/cursor-statusline-passthrough.json"

if [ -n "$SPACETERM_SURFACE_ID" ]; then
  {
    printf '{"type":"status-line","surfaceId":"%s","payload":%s}\n' "$SPACETERM_SURFACE_ID" "$INPUT"
  } | nc -w 1 -U "$SOCKET" >/dev/null 2>&1 &
fi

# Outside Spaceterm (or in addition): preserve a displaced user statusLine.
if [ -f "$PASSTHROUGH" ]; then
  CMD=$(python3 -c '
import json, sys
try:
    o = json.load(open(sys.argv[1]))
except Exception:
    raise SystemExit(0)
sl = o.get("statusLine") or {}
cmd = sl.get("command") if isinstance(sl, dict) else None
if isinstance(cmd, str) and cmd.strip():
    print(cmd)
' "$PASSTHROUGH" 2>/dev/null)
  if [ -n "$CMD" ]; then
    printf '%s' "$INPUT" | bash -c "$CMD"
    exit $?
  fi
fi

# Under Spaceterm with no passthrough: empty stdout (footer shows context %).
exit 0
