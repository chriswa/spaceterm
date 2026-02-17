---
name: claude-state-transition-research
description: Use when investigating Claude status/state bugs — cases where the Claude state indicator (working, waiting_permission, waiting_plan, stopped) shows the wrong value or transitions at the wrong time. Provides the file locations, IDs needed, and methodology for diagnosing state transition problems.
---

# Claude State Transition Research

## What you need from the user

Two IDs identify a debugging session:
- **Surface ID** (UUID) — identifies the spaceterm terminal surface. Used to find hook logs and decision logs.
- **Claude Session ID** (UUID) — identifies the Claude Code session. Used to find the JSONL transcript.

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

States: `stopped`, `working`, `waiting_permission`, `waiting_plan`

### Signals that set state

| Signal | Source | New State |
|--------|--------|-----------|
| `UserPromptSubmit` hook | hook | working |
| `PreToolUse` hook | hook | working |
| `SubagentStart` hook | hook | working |
| `PreCompact` hook | hook | working |
| `PermissionRequest` hook (ExitPlanMode) | hook | waiting_plan |
| `PermissionRequest` hook (other tools) | hook | waiting_permission |
| `Notification` (permission_prompt / elicitation_dialog) | hook | waiting_permission |
| `Stop` hook | hook | stopped |
| `SessionEnd` hook | hook | stopped |
| `SessionStart` hook (compact source) | hook | stopped |
| JSONL `assistant` entry | jsonl | working |
| JSONL `user` string entry | jsonl | working |
| JSONL `user` array with "interrupted by user" | jsonl | stopped |

### Signals that DON'T change state
- `PostToolUse` / `PostToolUseFailure` — not wired to transitions (known gap)
- `client:markRead` / `client:markUnread` — only toggles the `unread` flag, never changes state
- JSONL `user` array entries (tool results) without interruption — hooks handle this

### Guard logic
- `waiting_plan` cannot be downgraded to `waiting_permission` (Notification is suppressed)

### Transition queue
Events are held for 500ms then processed in source-timestamp order. This prevents race conditions between hook and JSONL events (e.g. a late JSONL assistant message overriding a Stop hook). The drain interval is 50ms.

## Key code locations

All in `src/server/index.ts`:
- **~line 117-163**: Transition queue (queueTransition, drainTransitionQueue)
- **~line 165-209**: applyTransition — guard logic, unread computation, decision logging
- **~line 303-379**: Hook event handlers — maps hook types to state transitions
- **~line 798-809**: markRead handler — client unread toggle
- **~line 920-965**: JSONL file watcher — maps transcript entries to state transitions

Supporting files:
- `src/shared/state.ts` — ClaudeState type definition
- `src/server/decision-logger.ts` — writes decision log entries
- `src/server/session-manager.ts` — holds per-surface state (claudeState, claudeStatusUnread)
- `src/server/state-manager.ts` — broadcasts state changes to clients
- `src/server/session-file-watcher.ts` — watches Claude JSONL files for new entries

## Investigation methodology

1. **Read the decision log first.** It shows every state transition with timestamps. Look for the gap — where did state stay wrong for too long?
2. **Cross-reference the hook log.** Find hook events that fired during the gap. Were any hooks missing from the state transition list?
3. **Check the JSONL transcript** if the decision log shows `jsonl:assistant` as the event that eventually corrected the state. This means no hook fired to do it sooner.
4. **Check for subagent interleaving.** If state bounces between `waiting_permission` and `working`, subagent tool events (PreToolUse, PostToolUse) may be clearing `waiting_permission` incorrectly — they fire on the same surface as the main agent.

## Known issues

### PostToolUse doesn't transition to working
After a user grants permission, the `PostToolUse` hook fires but doesn't trigger a state change. The state stays `waiting_permission` until a `jsonl:assistant` entry appears (5-10+ seconds later). `HOOK_INVESTIGATION.md` at the repo root documents the full hook investigation including the subagent interleaving edge case.

### Subagent events share the surface
`PreToolUse` and `PostToolUse` from subagents fire on the same surface ID as the main agent. If the main agent is waiting for permission while a subagent runs, the subagent's tool events can briefly clear `waiting_permission`. The `Notification(permission_prompt)` at +6s corrects this, but there's a window of incorrect state.
