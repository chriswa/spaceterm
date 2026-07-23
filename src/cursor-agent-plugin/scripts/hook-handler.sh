#!/bin/bash
# Normalize Cursor Agent hook payloads to the Claude-shaped events Spaceterm's
# server already understands, then send them to hooks.sock.
# Reads JSON from stdin. Backgrounded to avoid blocking the agent.

[ -z "$SPACETERM_SURFACE_ID" ] && exit 0

SOCKET="${SPACETERM_HOME:-$HOME/.spaceterm}/hooks.sock"
FAILURE_LOG="${SPACETERM_HOME:-$HOME/.spaceterm}/hook-failures.log"

# Resolve plugin root so relative paths in hooks.json work from any cwd.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PLUGIN_ROOT" || true

INPUT=$(cat)
TS=$(perl -MTime::HiRes=time -e 'printf "%d",time*1000')

# Map Cursor camelCase (and already-PascalCase) events → Spaceterm vocabulary,
# and conversation_id → session_id.
NORMALIZED=$(printf '%s' "$INPUT" | python3 /dev/fd/3 3<<'PY'
import json, sys
raw = sys.stdin.read()
try:
    o = json.loads(raw) if raw.strip() else {}
except Exception:
    sys.stdout.write("{}")
    raise SystemExit(0)

event = o.get("hook_event_name") or o.get("event") or ""
mapping = {
    "sessionStart": "SessionStart",
    "SessionStart": "SessionStart",
    "beforeSubmitPrompt": "UserPromptSubmit",
    "UserPromptSubmit": "UserPromptSubmit",
    "preToolUse": "PreToolUse",
    "PreToolUse": "PreToolUse",
    "stop": "Stop",
    "Stop": "Stop",
    "sessionEnd": "SessionEnd",
    "SessionEnd": "SessionEnd",
    "subagentStart": "SubagentStart",
    "SubagentStart": "SubagentStart",
    "subagentStop": "SubagentStop",
    "SubagentStop": "SubagentStop",
}
if event in mapping:
    o["hook_event_name"] = mapping[event]

session_id = o.get("session_id") or o.get("conversation_id") or ""
if session_id:
    o["session_id"] = session_id

# Subagent ledger keys on agent_id — accept Cursor's alternate field names.
if not o.get("agent_id"):
    for key in ("subagent_id", "subagentId", "agentId", "task_id", "taskId"):
        if o.get(key):
            o["agent_id"] = str(o[key])
            break

if o.get("hook_event_name") == "SessionStart" and "source" not in o:
    # Cursor does not always send source; default so Spaceterm can record history.
    o["source"] = "resume" if o.get("is_resume") or o.get("resumed") else "startup"

sys.stdout.write(json.dumps(o, separators=(",", ":")))
PY
)

MSG=$(printf '{"type":"hook","surfaceId":"%s","ts":%s,"payload":%s}' "$SPACETERM_SURFACE_ID" "$TS" "$NORMALIZED")

{
  for attempt in 1 2 3; do
    printf '%s\n' "$MSG" | nc -w 1 -U "$SOCKET" && exit 0
    [ "$attempt" -lt 3 ] && sleep 0.3
  done
  HOOK_TYPE=$(printf '%s' "$NORMALIZED" | python3 -c 'import json,sys; o=json.load(sys.stdin); print(o.get("hook_event_name") or "unknown")' 2>/dev/null || echo unknown)
  printf '{"ts":"%s","hookType":"%s","surfaceId":"%s","error":"all 3 delivery attempts failed"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "${HOOK_TYPE:-unknown}" \
    "$SPACETERM_SURFACE_ID" \
    >> "$FAILURE_LOG"
} &

exit 0
