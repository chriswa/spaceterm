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
- Client interaction handling (interaction only clears unread — it never mutates claudeState)
- Background ledger + liveness-probe logic (which launches are tracked, how they drain, why probes fail-safe to "still running")

## State machine invariants

When modifying transition logic, these invariants must be preserved:
1. PermissionRequest routes by tool_name: ExitPlanMode → waiting_plan, AskUserQuestion → waiting_question, everything else → waiting_permission
2. Notification hooks are intentionally not handled (permission_prompt is always redundant with PermissionRequest; elicitation_dialog has never been emitted by Claude Code — verified across 888 log files / 1,109 PermissionRequests)
3. PostToolUse only clears waiting_permission for matching tool_use_ids (prevents subagent events from clobbering main agent state)
4. Permission tracking maps are cleared on Stop, SessionEnd, and UserPromptSubmit
5. Unread flags are set when entering attention-needed states (stopped, waiting_permission, waiting_question, waiting_plan). NOT working or working_background — those are passive statuses that must not fire the completion tone.
6. The transition queue holds events for 500ms to prevent hook/JSONL race conditions
7. On Stop, the surface goes to `working_background` (yellow) if the background ledger is non-empty, else `stopped`. When the ledger drains (SubagentStop, a parsed <task-notification> completion, or a liveness probe) a `:bg-drained` transition to `stopped` is enqueued, gated in applyTransition to only fire from `working_background`. This gate is what makes the drain correct regardless of hook/queue ordering.
8. The background ledger tracks subagents via SubagentStart/SubagentStop hooks (agent_id) and bash/monitor/workflow via transcript tool_result acks. It is cleared on UserPromptSubmit (new turn) and SessionEnd. Correctness rests on the liveness probes (lsof/pgrep/subagent-tail/state-file), NOT on parsing every completion string; the reconciliation sweep drains anything whose completion we never saw. On server restart, a persisted `working_background` resets to `stopped` (the ledger is in-memory).
9. Status-line events do not drive state (handleStatusLine is a no-op) — the stale-sweep/`stuck` heuristic was removed.
10. Waiting states are sticky — only targeted signals can clear waiting → working: hook:PostToolUse/PostToolUseFailure (ID-matched), hook:UserPromptSubmit, and jsonl:permission-resolved (the tool_result for a pending permission tool_use_id — the transcript-based replacement for the old client Enter-keypress path). All other working signals (PreToolUse, SubagentStart, PreCompact, jsonl:assistant, jsonl:user:string) are suppressed. This prevents both subagent interleaving (61 occurrences across 607 decision logs) and parallel tool_use JSONL races from clobbering waiting states.
11. SessionStart does NOT drive state (including source=compact). Auto-compaction fires mid-turn and Claude auto-resumes; treating the compact SessionStart as idle caused a spurious tone + white flash on 42/42 historical compacts. Idle is signalled only by Stop; resume by the next transcript assistant entry.
