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

- Queue timing constants (e.g., why 500ms delay between event arrival and processing)
- Permission tracking correlation (PreToolUse → PermissionRequest → PostToolUse pipeline)
- Which hook events trigger which states, and why others are excluded
- JSONL entry routing decisions (e.g., why rejected → stopped instead of working)
- Client interaction handling (e.g., why Enter from working stays working — Escape is the interrupt key)
- Stale sweep logic (e.g., why 2min timeout, why working→stuck instead of working→stopped)

## State machine invariants

When modifying transition logic, these invariants must be preserved:
1. PermissionRequest routes by tool_name: ExitPlanMode → waiting_plan, AskUserQuestion → waiting_question, everything else → waiting_permission
2. Notification hooks are intentionally not handled (permission_prompt is always redundant with PermissionRequest; elicitation_dialog has never been emitted by Claude Code — verified across 888 log files / 1,109 PermissionRequests)
3. PostToolUse only clears waiting_permission for matching tool_use_ids (prevents subagent events from clobbering main agent state)
4. Permission tracking maps are cleared on Stop, SessionEnd, and UserPromptSubmit
5. Unread flags are set when entering attention-needed states (stopped, waiting_permission, waiting_question, waiting_plan)
6. The transition queue holds events for 500ms to prevent hook/JSONL race conditions
7. Stale sweep only transitions working→stuck (not other states) after 2min of no activity
8. Stop and SessionEnd clear lastActivityBySurface (prevents false stuck transitions after restart)
9. Status-line events reset lastActivityBySurface and recover from stuck→working (proves session is alive)
