---
name: claude-state-transition-research
description: Use when investigating Claude status/state bugs — cases where the Claude state indicator (working, waiting_permission, waiting_plan, stopped) shows the wrong value or transitions at the wrong time. Provides the file locations, IDs needed, and methodology for diagnosing state transition problems.
---

# Claude State Transition Research

## What you need from the user

Two IDs identify a debugging session:
- **Surface ID** (UUID) — identifies the spaceterm terminal surface. Used to find hook logs and decision logs.
- **Claude Session ID** (UUID) — identifies the Claude Code session. Used to find the JSONL transcript.

The *current* session's IDs are available as environment variables: `SPACETERM_SURFACE_ID` and `CLAUDE_SESSION_ID`. If the user is investigating the current session, read these directly instead of asking. If investigating a different session, ask the user for the IDs.

## Key files

### 1. Decision Log (start here)
```
~/.spaceterm/decision-logs/{surfaceId}.jsonl
```
The authoritative record of every state transition. Each line has: `timestamp`, `source` (hook/jsonl/client), `event`, `prevState`, `newState`, `unread`, and optionally `detail` or `suppressed`. This is the fastest way to see what happened.

### 2. Hook Log
```
~/.spaceterm/hook-logs/{surfaceId}.jsonl
```
Raw hook events from Claude Code (SessionStart, PreToolUse, PermissionRequest, PostToolUse, Stop, etc.) plus status-line payloads. Contains full tool_input/tool_response payloads. Use this for timing details and to see events that don't trigger state transitions.

### 3. Claude Session Transcript
```
~/.claude/projects/{cwdSlug}/{claudeSessionId}.jsonl
```
The Claude Code JSONL transcript. Contains assistant messages, user messages, and tool results. The JSONL file watcher uses this to detect `assistant` entries (→ working) and `user` entries (→ working or stopped on interrupt).

### 4. Electron Log
```
~/.spaceterm/electron.log
```
General application log. Check for errors around the timestamps in question.

## State machine overview

States: `stopped`, `working`, `waiting_permission`, `waiting_question`, `waiting_plan`, `stuck`

### Signals that set state

| Signal | Source | New State |
|--------|--------|-----------|
| `UserPromptSubmit` hook | hook | working |
| `PreToolUse` hook | hook | working (suppressed when in waiting state) |
| `SubagentStart` hook | hook | working (suppressed when in waiting state) |
| `PreCompact` hook | hook | working (suppressed when in waiting state) |
| `PostToolUse` hook (ID-matched) | hook | working |
| `PostToolUseFailure` hook (ID-matched) | hook | working |
| `PermissionRequest` hook (ExitPlanMode) | hook | waiting_plan |
| `PermissionRequest` hook (AskUserQuestion) | hook | waiting_question |
| `PermissionRequest` hook (other tools) | hook | waiting_permission |
| `Stop` hook | hook | stopped |
| `SessionEnd` hook | hook | stopped |
| `SessionStart` hook (compact source) | hook | stopped |
| JSONL `assistant` entry | jsonl | working (suppressed when in waiting state) |
| JSONL `user` string entry | jsonl | working (suppressed when in waiting state) |
| JSONL `user` array with "interrupted by user" | jsonl | stopped |
| JSONL `user` array with "rejected" | jsonl | stopped |
| stale sweep (2min timeout) | stale | stuck (from working only) |

### Signals that DON'T change state
- `PostToolUse` / `PostToolUseFailure` with non-matching tool_use_id — ignored (prevents subagent events from clobbering main agent state)
- `Notification` hooks — intentionally not handled (always redundant with PermissionRequest)
- `client:markRead` / `client:markUnread` — only toggles the `unread` flag, never changes state
- JSONL `user` array entries (tool results) without interruption or rejection — hooks handle this

### Guard logic
- Waiting states are sticky — only `hook:PostToolUse`/`hook:PostToolUseFailure` (ID-matched), `hook:UserPromptSubmit`, and `client:promptSubmit` can transition waiting → working. All other working signals are suppressed.

### Transition queue
Events are held for 500ms then processed in source-timestamp order. This prevents race conditions between hook and JSONL events (e.g. a late JSONL assistant message overriding a Stop hook). The drain interval is 50ms.

## Key code locations

State machine: `src/server/claude-state/index.ts` (single file for all transition logic):
- `handleHook()` — maps hook types to state transitions, manages permission tracking (lastPreToolUseId, pendingPermissionIds)
- `handleJsonlEntries()` — maps JSONL transcript entries to state transitions
- `handleClientWrite()` — handles Enter key / prompt submit (bypasses applyTransition)
- `applyTransition()` — guard logic, unread computation, decision logging. The sticky-waiting-states guard lives here.
- `sweepStaleSurfaces()` — detects working → stuck after 2min inactivity

Supporting files:
- `src/server/claude-state/transition-queue.ts` — 500ms delay queue, source-timestamp ordering
- `src/server/claude-state/decision-logger.ts` — writes decision log entries
- `src/server/claude-state/types.ts` — ClaudeState type, StateMachineDeps interface
- `src/server/session-manager.ts` — holds per-surface state (claudeState, claudeStatusUnread)
- `src/server/state-manager.ts` — broadcasts state changes to clients
- `src/server/session-file-watcher.ts` — watches Claude JSONL files for new entries

## Interleaved timeline tool

`interleave-logs.js` merges decision, hook, transcript, and electron logs into a single chronological timeline. Use it to see the full picture without manually cross-referencing files.

```bash
# Basic usage — auto-discovers session from hook log
node .claude/skills/claude-state-transition-research/interleave-logs.js <surfaceId>

# Zoom into a specific time window
node .claude/skills/claude-state-transition-research/interleave-logs.js <surfaceId> \
  --from 2026-02-17T07:35:36-08:00 --to 2026-02-17T07:35:44-08:00

# Include electron log (requires --from/--to to avoid noise)
node .claude/skills/claude-state-transition-research/interleave-logs.js <surfaceId> \
  --sources decision,hook,transcript,electron --from <start> --to <end>

# Hide status-line entries for cleaner output
node .claude/skills/claude-state-transition-research/interleave-logs.js <surfaceId> --skip-status-lines

# Use a specific transcript file directly
node .claude/skills/claude-state-transition-research/interleave-logs.js <surfaceId> \
  --transcript ~/.claude/projects/-Users-me-myproject/session-id.jsonl
```

Output format: `HH:MM:SS.mmm  [source]  file:line  summary`. Timestamps are local timezone. Source tags: `[decision]`, `[hook]`, `[transcript]`, `[electron]`. Run with `--help` for full options.

## Investigation methodology

1. **Read the decision log first.** It shows every state transition with timestamps. Look for the gap — where did state stay wrong for too long?
2. **Cross-reference the hook log.** Find hook events that fired during the gap. Were any hooks missing from the state transition list?
3. **Check the JSONL transcript** if the decision log shows `jsonl:assistant` as the event that eventually corrected the state. This means no hook fired to do it sooner.
4. **Check for subagent interleaving.** If state bounces between `waiting_permission` and `working`, subagent tool events (PreToolUse, PostToolUse) may be clearing `waiting_permission` incorrectly — they fire on the same surface as the main agent.

## Before proposing a fix: counterexample analysis

Before changing transition logic, search ALL decision logs (`~/.spaceterm/decision-logs/*.jsonl`) for counterexamples — cases where the transition you want to suppress was actually correct. For example, if you want to prevent `PreToolUse` from clearing `waiting_permission`, search for every instance where it did clear it and verify that NONE were legitimate.

```bash
# Find all instances where PreToolUse cleared a waiting state
for f in ~/.spaceterm/decision-logs/*.jsonl; do
  python3 -c "
import json, sys
for i, line in enumerate(open('$f')):
    d = json.loads(line)
    if d.get('event') == 'hook:PreToolUse' and d.get('prevState','').startswith('waiting_') and d.get('newState') == 'working':
        print(f'$f:{i+1}  {d[\"timestamp\"]}  {d[\"prevState\"]} -> {d[\"newState\"]}')
" 2>/dev/null
done
```

For each match, check the surrounding lines: was there a PostToolUse that should have cleared the state first? Did the state bounce back to waiting immediately? A fix with zero counterexamples across all logs is safe to ship.

## Canonical data points (regression testing)

File: `.claude/skills/claude-state-transition-research/canonical-observations.jsonl`

This file contains user-reported observations — moments where the user told us what they saw on screen and what the correct state should have been. Each line is a JSON object with:
- `timestamp` — when the observation occurred (ISO 8601)
- `surfaceId` — which surface was affected
- `claudeSessionId` — the Claude Code session ID (needed to find the JSONL transcript)
- `observedState` — what the indicator was showing
- `expectedState` — what it should have been showing
- `context` — brief description of what Claude was actually doing
- `rootCause` — (added after investigation) what caused the wrong state
- `fixed` — whether this class of bug has been fixed, and how

**Before shipping any state machine change**, replay all canonical observations against the new logic to confirm none regress. For each entry, read the decision log at the given timestamp and verify the new code would produce `expectedState`.

**When the user reports a new bug**, always append a new line to this file with their observation before starting the investigation. This is the single source of truth for "what the user actually saw" — decision logs show what the code decided, but only this file records what was *correct*.

## Known issues

### Subagent events share the surface
`PreToolUse` and `PostToolUse` from subagents fire on the same surface ID as the main agent. The sticky-waiting-states guard in `applyTransition` prevents subagent `PreToolUse` events from clobbering waiting states. `PostToolUse` is protected by tool_use_id matching (only the ID-matched permission-gated tool clears the state).
