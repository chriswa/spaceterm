# Claude Session Recovery Runbook

How to recover a Claude Code session that has disappeared from spaceterm — i.e.
Cmd+K can't find it by session ID, but the conversation existed recently and you
want it back as a surface on the canvas.

First used 2026-07-06 to recover session `ce1b6d34-b98f-4561-a0d7-abb664c5ed6e`.

## Why this happens

Known failure mode: a surface is started with `claude -r <old-id>`. Claude Code
gives the resumed conversation a **new** session ID, but the node's
`claudeSessionHistory` in `~/.spaceterm/state.json` may keep pointing at the old
ID. When the terminal is later reincarnated (app restart, PTY death), spaceterm
resumes the **stale pre-fork session** — the surface silently rewinds, and no
node references the new session ID anymore, so Cmd+K can't find it.

## Step 1 — Confirm the session transcript still exists

Claude Code transcripts live under `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`,
where the slug is the project cwd with `/` replaced by `-` (e.g.
`/Users/chriswaddell/Sightline` → `-Users-chriswaddell-Sightline`).

```bash
find ~/.claude/projects -name "<session-id>*"
```

If the JSONL exists, the conversation is fully recoverable. Note the project
directory — it tells you the session's `cwd`, which you need below. If it
doesn't exist, the session is gone; stop here.

## Step 2 — Confirm it's absent from spaceterm state

```bash
grep -c "<session-id>" ~/.spaceterm/state.json
```

- **Non-zero**: the session is still wired to a node — your problem is
  something else (maybe the node is archived; check `rootArchivedChildren` and
  nodes' `archivedChildren`).
- **Zero**: proceed. Optionally reconstruct what happened via
  `~/.spaceterm/hook-logs/<node-id>.jsonl` — grep them for the session ID and
  look at `SessionStart`/`SessionEnd` events to find which node hosted it.

## Step 3 — Back up state.json (always, before any edit)

```bash
cp ~/.spaceterm/state.json ~/.spaceterm/state.json.backup-$(date +%Y%m%d-%H%M%S)
```

## Step 4 — Quit the spaceterm server (NOT the pty daemon)

**Required — server only.** The server holds state in memory and rewrites
`state.json` on every change *and at shutdown* — any edit made while it runs
will be clobbered.

**Do not kill the pty daemon** (`pty-daemon`). It is a separate process,
doesn't touch `state.json`, and keeps all PTYs (including running Claude
sessions) alive across the server restart — the server re-attaches to them on
relaunch instead of respawning.

Verify the server is down: `pgrep -f "tsx src/server/index.ts"` should print
nothing.

## Step 5 — Add a terminal node referencing the session

Insert a new node into `.nodes` in `~/.spaceterm/state.json`. The key facts
about the schema (see `src/shared/state.ts`, `TerminalNodeData`):

- On startup, the server revives every terminal node by taking the **last
  entry** of `claudeSessionHistory`, checking its JSONL exists under the node's
  `cwd`'s project slug, and spawning `claude -r <id>` (see
  `findValidClaudeSession` and the startup revival loop in
  `src/server/index.ts`).
- `sessionId` (the PTY session) should initially equal the node `id`.
- `sortOrder` must be unique-ish: use `max(existing terminal sortOrders) + 1`.
- `zIndex`: use the current `.nextZIndex`, then increment `.nextZIndex`.
- `parentId`: any existing node ID, or `"root"` for top-level.

A tested apply script (adjust the four variables at the top):

```bash
#!/bin/bash
set -euo pipefail

STATE=~/.spaceterm/state.json
LOST_SESSION="<session-id>"
PARENT_ID="root"                 # or an existing node id
CWD="/Users/you/project"         # cwd matching the transcript's project slug

if pgrep -f "tsx src/server/index.ts" >/dev/null 2>&1; then
  echo "ERROR: spaceterm server is running. Quit it first." >&2; exit 1
fi

NODE_ID=$(uuidgen | tr 'A-Z' 'a-z')
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)

jq --arg id "$NODE_ID" --arg parent "$PARENT_ID" \
   --arg sess "$LOST_SESSION" --arg cwd "$CWD" --arg now "$NOW" '
  (if $parent == "root" then {x: 0, y: 0} else .nodes[$parent] end) as $p |
  ([.nodes[] | select(.type=="terminal") | .sortOrder] | max + 1) as $sort |
  .nodes[$id] = {
    id: $id, type: "terminal", alive: false, sessionId: $id,
    parentId: $parent, x: ($p.x + 200), y: ($p.y + 1000),
    zIndex: .nextZIndex, cols: 160, rows: 45, cwd: $cwd,
    claudeState: "stopped", claudeStatusUnread: false, claudeStatusAsleep: false,
    sortOrder: $sort,
    terminalSessions: [{ sessionIndex: 0, startedAt: $now, endedAt: $now,
      trigger: "initial", claudeSessionId: $sess, shellTitleHistory: [] }],
    claudeSessionHistory: [{ claudeSessionId: $sess, reason: "resume", timestamp: $now }],
    shellTitleHistory: [], archivedChildren: [], colorPresetId: "inherit",
    name: "Revived session"
  } |
  .nextZIndex += 1
' "$STATE" > "$STATE.tmp"

jq -e --arg id "$NODE_ID" --arg sess "$LOST_SESSION" \
  '.nodes[$id].claudeSessionHistory[0].claudeSessionId == $sess' "$STATE.tmp" >/dev/null

mv "$STATE.tmp" "$STATE"
echo "OK: added node $NODE_ID resuming $LOST_SESSION — relaunch spaceterm"
```

## Step 6 — Relaunch spaceterm

The startup revival loop finds the new node, validates the JSONL, and spawns
`claude -r <session-id>` in a fresh surface at the position you chose. Rename
it as desired.

## Rollback

Restore the backup from Step 3 while the server is stopped:

```bash
cp ~/.spaceterm/state.json.backup-<stamp> ~/.spaceterm/state.json
```
