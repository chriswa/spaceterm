---
paths:
  - "src/server/claude-state/**/*"
---

# Claude State Machine — Commenting Rules

Every business logic decision in this directory MUST have a comment explaining:
- **Why** this choice was made (not just what the code does)
- **Edge cases** considered and how they're handled
- **Alternatives rejected** and why they were rejected

This directory contains the Claude state indicator's state machine. Decisions here
have been debugged and iterated on extensively. Comments preserve this context so
future iterations don't re-introduce solved problems.

## What needs comments

- State transition guards (e.g., why waiting_plan cannot be downgraded to waiting_permission)
- Queue timing constants (e.g., why 500ms delay between event arrival and processing)
- Permission tracking correlation (PreToolUse → PermissionRequest → PostToolUse pipeline)
- Which hook events trigger which states, and why others are excluded
- JSONL entry routing decisions (e.g., why rejected → stopped instead of working)
- Client interaction handling (e.g., why Enter from working stays working — Escape is the interrupt key)
- Stale sweep logic (e.g., why 2min timeout, why working→stuck instead of working→stopped)

## State machine invariants

When modifying transition logic, these invariants must be preserved:
1. `waiting_plan` → `waiting_permission` downgrade is blocked (PermissionRequest already set the more specific state)
2. PostToolUse only clears waiting_permission for matching tool_use_ids (prevents subagent events from clobbering main agent state)
3. Permission tracking maps are cleared on Stop, SessionEnd, and UserPromptSubmit
4. Unread flags are set when entering attention-needed states (stopped, waiting_permission, waiting_plan)
5. The transition queue holds events for 500ms to prevent hook/JSONL race conditions
6. Stale sweep only transitions working→stuck (not other states) after 2min of no activity
7. Stop and SessionEnd clear lastActivityBySurface (prevents false stuck transitions after restart)
8. Status-line events reset lastActivityBySurface and recover from stuck→working (proves session is alive)
