# Claude Code Hook Investigation

Investigation into Claude Code hook events for detecting when a Claude Code session is waiting for user input.

## All 14 Hook Events

| Event | When it fires | Matcher filters | Indicates user waiting? |
|---|---|---|---|
| `SessionStart` | Session begins or resumes | `source`: startup, resume, clear, compact | No — user just acted, or auto-compact |
| `UserPromptSubmit` | User submits a prompt, before Claude processes it | None (always fires) | No — user just typed, Claude about to work |
| `PreToolUse` | Before a tool call executes (can block it) | Tool name: Bash, Edit, Write, Read, Glob, Grep, Task, WebFetch, WebSearch, mcp__* | No — Claude is actively working |
| `PermissionRequest` | Permission dialog appears | Tool name (same as PreToolUse) | Unreliable — fires even for auto/quick approvals |
| `PostToolUse` | After a tool call succeeds | Tool name | No — Claude is working |
| `PostToolUseFailure` | After a tool call fails | Tool name | No — Claude is working |
| `Notification` | Claude Code sends a notification | `notification_type`: permission_prompt, idle_prompt, auth_success, elicitation_dialog | **Depends on type** (see table below) |
| `SubagentStart` | Subagent spawned | Agent type: Bash, Explore, Plan, custom | No — Claude is working |
| `SubagentStop` | Subagent finished | Agent type | No — Claude is working |
| `Stop` | Claude finishes responding | None (always fires) | **YES — waiting for next prompt** |
| `TeammateIdle` | Agent team teammate going idle | None | No — team orchestration internal |
| `TaskCompleted` | Task marked as completed | None | No — internal bookkeeping |
| `PreCompact` | Before context compaction | `trigger`: manual, auto | No — automatic operation |
| `SessionEnd` | Session terminates | `reason`: clear, logout, prompt_input_exit, bypass_permissions_disabled, other | Session is done |

## Notification Types

The `Notification` hook fires with a `notification_type` field. Each type has different implications:

| `notification_type` | When it fires | Indicates user waiting? | Notes |
|---|---|---|---|
| `permission_prompt` | Permission dialog has been pending ~6 seconds | **YES** | Only fires if user hasn't resolved the permission quickly. The 6-second delay filters out auto-approved permissions. |
| `idle_prompt` | Claude has been idle ~60 seconds after Stop | YES (redundant) | Reinforces the Stop event. The user was already waiting; this is a reminder. |
| `elicitation_dialog` | AskUserQuestion or plan approval dialog shown | **YES** | Not observed in our logs but documented by Anthropic. |
| `auth_success` | Authentication completed | No | Informational only. |

## Key Timing Patterns (from log analysis)

### Normal turn cycle
```
UserPromptSubmit → [PreToolUse/PostToolUse...] → Stop → [user idle] → UserPromptSubmit
```

### Permission needed
```
PreToolUse → PermissionRequest → ~6s → Notification(permission_prompt) → [user approves] → PostToolUse → [more tools] → Stop
```

**Critical finding:** `PermissionRequest` fires consistently ~6 seconds before `Notification(permission_prompt)`. The Notification ONLY fires if the user hasn't resolved the permission within ~6 seconds. Auto-approved or quickly-approved permissions produce a `PermissionRequest` but NO Notification. This makes `Notification(permission_prompt)` the reliable signal for "user needs to pay attention."

### Idle user
```
Stop → ~60s → Notification(idle_prompt) → [still waiting] → UserPromptSubmit
```

### Subagent interleaving
Subagent `PreToolUse`/`PostToolUse` events fire on the same surface ID while the main agent's permission dialog is pending. This means tool activity events **cannot** be used to clear the waiting state — they might be from subagents, not the main agent.

Example observed in logs:
```
23:30:23  PreToolUse tool=WebFetch          (main agent)
23:30:23  PermissionRequest tool=WebFetch   (permission dialog appears)
23:30:27  PreToolUse tool=Task              (main agent spawns subagent IN PARALLEL)
23:30:27  SubagentStart                     (subagent running)
23:30:29  Notification permission_prompt    (WebFetch still waiting for user)
23:30:31  PreToolUse tool=Bash              (subagent working - NOT permission resolution!)
23:30:33  PreToolUse tool=Glob              (subagent working)
23:30:33  PostToolUse tool=Glob             (subagent completed)
```

## waitingForUser State Machine

### Set `waitingForUser = true` when:
1. **`Stop`** fires — Claude finished responding, waiting for next user prompt
2. **`Notification(permission_prompt)`** fires — permission dialog pending 6+ seconds
3. **`Notification(elicitation_dialog)`** fires — question/plan dialog shown

### Set `waitingForUser = false` when:
1. **`UserPromptSubmit`** fires — user submitted a prompt, Claude is working
2. **`SessionEnd`** fires — session is done

### Events that DON'T change the state:
- `SessionStart` — user is already present (they just launched/resumed), or it's auto-compact
- `PreToolUse` / `PostToolUse` — can't distinguish main agent vs subagent activity
- `PermissionRequest` — fires even for auto-approved permissions (false positives)
- `Notification(idle_prompt)` — Stop already set waiting=true; redundant
- `SubagentStart/Stop`, `PreCompact`, `TaskCompleted`, `TeammateIdle` — internal

### Known edge case: permission approval → Claude continues
After a user approves a permission, `PostToolUse` fires and Claude continues working until the next `Stop`. During this brief period, `waitingForUser` is still `true` (from the earlier `Notification(permission_prompt)`). This is a minor false positive — the user just interacted with the dialog and knows Claude is working. It self-corrects at the next `UserPromptSubmit`.

### Not yet observed: `elicitation_dialog`
The `elicitation_dialog` notification type is documented but was not found in any of our 46 hook log files. If plan approval or `AskUserQuestion` triggers a different mechanism (e.g., just a `Stop` event), the `Stop` handler covers it. If `elicitation_dialog` fires, it's handled too. Either way, the user gets alerted.

## Hook Payload Reference

### Common fields (all events)
```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/path/to/project",
  "permission_mode": "default",
  "hook_event_name": "Stop"
}
```

### Stop payload
```json
{
  "stop_hook_active": false
}
```

### Notification payload
```json
{
  "notification_type": "permission_prompt",
  "message": "Claude needs your permission to use Bash",
  "title": ""
}
```

### SessionStart payload
```json
{
  "source": "startup",
  "model": "claude-opus-4-6"
}
```

### SessionEnd payload
```json
{
  "reason": "prompt_input_exit"
}
```

### UserPromptSubmit payload
```json
{
  "prompt": "the user's message text"
}
```

### PermissionRequest payload
```json
{
  "tool_name": "Bash",
  "tool_input": { "command": "npm test" },
  "permission_suggestions": [...]
}
```
