/**
 * Claude State Machine
 *
 * Manages the state indicator for each Claude Code surface (terminal session).
 * States: stopped → working → waiting_permission / waiting_question / waiting_plan → stopped
 *         working → stuck (after 2min timeout, recovered by any live event)
 *
 * This module is the single source of truth for state transition logic.
 * It was extracted from the monolithic src/server/index.ts so that business
 * logic decisions are preserved across iterations and the state machine
 * is independently readable.
 *
 * Design principles:
 * - Every business logic decision has a comment explaining WHY
 * - The transition queue prevents hook/JSONL race conditions
 * - Permission tracking correlates PreToolUse → PermissionRequest → PostToolUse
 * - Stale sweep catches sessions that silently stop producing events
 */

import type { StateMachineDeps, ClaudeState } from './types'
import type { SessionFileEntry } from '../session-file-watcher'
import { TransitionQueue } from './transition-queue'
import { DecisionLogger } from './decision-logger'
import { localISOTimestamp } from '../timestamp'

export { DecisionLogger } from './decision-logger'
export type { DecisionLogEntry } from './decision-logger'
export type { StateMachineDeps } from './types'

// ─── Stale sweep constants ──────────────────────────────────────────────────

/**
 * How long (ms) a surface can stay in 'working' with no events before it's
 * considered stuck.
 *
 * 2 minutes is long enough to avoid false positives from slow tool executions
 * (e.g. large file writes, long-running bash commands) while short enough to
 * catch genuinely stuck sessions. Claude Code's status-line events fire every
 * ~10s when active, so 2min means ~12 missed heartbeats.
 */
const STALE_WORKING_TIMEOUT_MS = 2 * 60 * 1000

/**
 * How often (ms) to check for stale working surfaces.
 *
 * 15s is a good balance: frequent enough that stuck detection is responsive
 * (worst case: 2min + 15s before the user sees "stuck"), but infrequent
 * enough to be negligible CPU cost.
 */
const STALE_SWEEP_INTERVAL_MS = 15_000

// ─── ClaudeStateMachine ─────────────────────────────────────────────────────

export class ClaudeStateMachine {
  private deps: StateMachineDeps
  private decisionLogger: DecisionLogger
  private transitionQueue: TransitionQueue

  /**
   * Last event timestamp per surface — updated by applyTransition and
   * queueTransition. Used by the stale sweep to detect surfaces that have
   * been in 'working' with no events for too long.
   *
   * Cleared on Stop, SessionEnd (the session is done, so there's nothing
   * to go stale) and prevents false stuck transitions after a session restarts.
   */
  private lastActivityBySurface = new Map<string, number>()
  private staleSweepTimer: ReturnType<typeof setInterval> | null = null

  // ─── Permission tracking ────────────────────────────────────────────────
  //
  // Claude Code fires hooks in this sequence for permission-gated tools:
  //   PreToolUse(tool_use_id) → PermissionRequest → [user approves] → PostToolUse(tool_use_id)
  //
  // We track tool_use_ids to correlate PostToolUse with the specific
  // permission-gated tool, because subagent PostToolUse events (with
  // different tool_use_ids) would incorrectly clear waiting_permission
  // on the main agent's surface if we didn't match IDs.
  //
  // lastPreToolUseId: captures the tool_use_id from the most recent PreToolUse
  //   so we can associate it with the subsequent PermissionRequest.
  //
  // pendingPermissionIds: accumulates tool_use_ids that are waiting for
  //   PostToolUse confirmation. A Set because multiple permissions can be
  //   pending simultaneously (e.g. parallel tool calls).
  //
  // Both maps are cleared on Stop, SessionEnd, and UserPromptSubmit because
  // these events invalidate any pending permission state.

  /** surfaceId → tool_use_id from the most recent PreToolUse */
  private lastPreToolUseId = new Map<string, string>()
  /** surfaceId → Set of tool_use_ids awaiting PostToolUse confirmation */
  private pendingPermissionIds = new Map<string, Set<string>>()

  constructor(deps: StateMachineDeps) {
    this.deps = deps
    this.decisionLogger = new DecisionLogger()
    this.transitionQueue = new TransitionQueue(
      (surfaceId, newState, source, event, detail) =>
        this.applyTransition(surfaceId, newState, source, event, detail)
    )
    this.staleSweepTimer = setInterval(() => this.sweepStaleSurfaces(), STALE_SWEEP_INTERVAL_MS)
  }

  dispose(): void {
    if (this.staleSweepTimer) {
      clearInterval(this.staleSweepTimer)
      this.staleSweepTimer = null
    }
    // TransitionQueue.dispose() flushes remaining transitions before stopping
    this.transitionQueue.dispose()
  }

  // ─── Public handlers ──────────────────────────────────────────────────────

  /**
   * Process a hook event from Claude Code's plugin system.
   *
   * Hook events are the primary signal for state transitions because they
   * come directly from Claude Code's lifecycle (not parsed from files).
   * The hookTime parameter uses msg.ts when available for accurate ordering.
   */
  handleHook(surfaceId: string, hookType: string, payload: Record<string, unknown>, hookTime: number): void {
    // Any hook event proves the Claude process is alive — reset the stale timer.
    // This must happen before any transition logic so that stuck recovery works
    // even for hook types that don't explicitly queue a transition.
    this.lastActivityBySurface.set(surfaceId, Date.now())

    // If the session was marked stuck, any hook event means it's actually working.
    // We don't need to check which hook type — if hooks are flowing, Claude is alive.
    if (this.deps.getClaudeState(surfaceId) === 'stuck') {
      this.transitionQueue.enqueue(surfaceId, 'working', 'hook', `hook:unstuck:${hookType}`, hookTime)
    }

    // ── Stop: session ended by user or Claude ──
    // Stop means the current Claude turn is finished. We transition to stopped
    // and clear all permission tracking state (any pending permissions are moot).
    if (hookType === 'Stop') {
      this.deps.handleClaudeStop(surfaceId)
      this.transitionQueue.enqueue(surfaceId, 'stopped', 'hook', 'hook:Stop', hookTime)
      this.pendingPermissionIds.delete(surfaceId)
      this.lastPreToolUseId.delete(surfaceId)
      this.lastActivityBySurface.delete(surfaceId)
    }

    // ── PermissionRequest: Claude needs user approval or attention ──
    // Check tool_name to route to the correct waiting state:
    // - ExitPlanMode → waiting_plan (user reviews the plan)
    // - AskUserQuestion → waiting_question (Claude is asking a question)
    // - Everything else → waiting_permission (user approves/denies a tool)
    if (hookType === 'PermissionRequest') {
      // Capture tool_use_id from the preceding PreToolUse so we can match
      // the eventual PostToolUse to this specific permission-gated tool.
      const savedToolUseId = this.lastPreToolUseId.get(surfaceId)
      if (savedToolUseId) {
        let ids = this.pendingPermissionIds.get(surfaceId)
        if (!ids) { ids = new Set(); this.pendingPermissionIds.set(surfaceId, ids) }
        ids.add(savedToolUseId)
      }
      const toolName = payload && typeof payload === 'object' && 'tool_name' in payload
        ? String(payload.tool_name)
        : ''
      this.transitionQueue.enqueue(
        surfaceId,
        // ExitPlanMode → waiting_plan (user reviews the plan)
        // AskUserQuestion → waiting_question (Claude is asking a question, not requesting tool approval)
        // Everything else → waiting_permission (user approves/denies a tool)
        toolName === 'ExitPlanMode' ? 'waiting_plan'
          : toolName === 'AskUserQuestion' ? 'waiting_question'
          : 'waiting_permission',
        'hook',
        'hook:PermissionRequest',
        hookTime,
        toolName
      )
    }

    // ── Notification hooks are intentionally NOT handled here ──
    // permission_prompt notifications are always redundant with PermissionRequest
    // (~6s delayed follow-up, 0/1109 cases of being sole signal in historical data).
    // elicitation_dialog notifications have never been emitted by Claude Code.
    // Removing this handler also eliminates the need for the waiting_plan →
    // waiting_permission downgrade guard that existed solely to block the
    // late-arriving notification from clobbering waiting_plan state.

    // ── Working signals: Claude is actively processing ──
    // UserPromptSubmit: user just sent a message, Claude will start working
    // PreToolUse: Claude is about to execute a tool
    // SubagentStart: Claude spawned a subagent
    // PreCompact: Claude is about to compact context
    if (hookType === 'UserPromptSubmit' || hookType === 'PreToolUse' || hookType === 'SubagentStart' || hookType === 'PreCompact') {
      if (hookType === 'PreToolUse') {
        // Track the tool_use_id so PermissionRequest can associate it.
        // We overwrite any previous value because only the most recent
        // PreToolUse is relevant — older ones have already been handled.
        const toolUseId = payload?.tool_use_id
        if (typeof toolUseId === 'string') {
          this.lastPreToolUseId.set(surfaceId, toolUseId)
        }
      }
      if (hookType === 'UserPromptSubmit') {
        // A new user prompt invalidates all pending permissions — the user
        // is starting a fresh turn, so any unresolved permission requests
        // from the previous turn are stale.
        this.pendingPermissionIds.delete(surfaceId)
        this.lastPreToolUseId.delete(surfaceId)
      }
      this.transitionQueue.enqueue(surfaceId, 'working', 'hook', `hook:${hookType}`, hookTime)
    }

    // ── PostToolUse: a tool finished executing ──
    // Only transition to working if this matches a permission-gated tool.
    // Subagent PostToolUse events (with different tool_use_ids) are correctly
    // ignored, preventing them from clearing waiting_permission on the main
    // agent's surface. This is critical: without ID matching, a subagent
    // completing a tool would falsely show the main agent as "working" when
    // it's still waiting for user permission on a different tool.
    if (hookType === 'PostToolUse' || hookType === 'PostToolUseFailure') {
      const toolUseId = payload?.tool_use_id
      const ids = this.pendingPermissionIds.get(surfaceId)
      if (typeof toolUseId === 'string' && ids?.delete(toolUseId)) {
        this.transitionQueue.enqueue(surfaceId, 'working', 'hook', `hook:${hookType}`, hookTime)
      }
    }

    // ── SessionEnd: Claude session is done ──
    // Similar to Stop but more final — the session process itself is ending.
    // Clean up all tracking state to prevent stale data from affecting
    // a future session on the same surface.
    if (hookType === 'SessionEnd') {
      this.transitionQueue.enqueue(surfaceId, 'stopped', 'hook', 'hook:SessionEnd', hookTime)
      this.pendingPermissionIds.delete(surfaceId)
      this.lastPreToolUseId.delete(surfaceId)
      this.lastActivityBySurface.delete(surfaceId)
    }

    // ── SessionStart(compact): compaction finished ──
    // After compaction, Claude is idle waiting for input (it doesn't auto-resume).
    // This is different from a normal SessionStart which may immediately begin
    // processing a resumed conversation.
    if (hookType === 'SessionStart' && payload && typeof payload === 'object') {
      const source = 'source' in payload ? String(payload.source) : 'startup'
      if (source === 'compact') {
        this.transitionQueue.enqueue(surfaceId, 'stopped', 'hook', 'hook:SessionStart:compact', hookTime)
      }
    }
  }

  /**
   * Process a status-line event from Claude Code.
   *
   * Status-line events are periodic heartbeats (~10s interval) that prove
   * the Claude process is alive. They carry context window usage data but
   * no state transition information — except as a recovery mechanism for
   * stuck sessions.
   */
  handleStatusLine(surfaceId: string): void {
    // Reset the stale timer — this proves the session is alive
    this.lastActivityBySurface.set(surfaceId, Date.now())

    // If the session was marked stuck, a status-line event means it's
    // actually working. Status-line events only fire when Claude's process
    // is running, so this is a reliable recovery signal.
    if (this.deps.getClaudeState(surfaceId) === 'stuck') {
      this.transitionQueue.enqueue(surfaceId, 'working', 'status-line', 'status-line:unstuck', Date.now())
    }
  }

  /**
   * Process new JSONL entries from Claude Code's session file.
   *
   * JSONL entries are the secondary signal for state transitions. They're
   * parsed from the session transcript file and provide information that
   * hooks don't carry (e.g. whether a user message was an interrupt or
   * a rejection). During backfill (initial file read), we skip state
   * transitions to avoid replaying historical state changes.
   */
  handleJsonlEntries(surfaceId: string, entries: SessionFileEntry[], isBackfill: boolean): void {
    // During backfill, don't transition state — we're reading historical entries
    // from disk that have already been processed. State routing during backfill
    // would replay old transitions and could leave the indicator in a wrong state.
    if (isBackfill) return

    for (const entry of entries) {
      // Parse source timestamp from the JSONL entry (falls back to now if missing/invalid).
      // The timestamp is crucial for the transition queue's ordering guarantee.
      const entryTime = typeof entry.timestamp === 'string'
        ? new Date(entry.timestamp as string).getTime() || Date.now()
        : Date.now()

      // ── Assistant message → working ──
      // Claude is actively producing output. This is the most common JSONL
      // signal and serves as a reliable "working" indicator even when hooks
      // are delayed or missing.
      if (entry.type === 'assistant') {
        this.transitionQueue.enqueue(surfaceId, 'working', 'jsonl', 'jsonl:assistant', entryTime)
        continue
      }

      if (entry.type === 'user') {
        // Skip injected meta context (skills, system reminders) — these are
        // internal Claude Code events, not human interactions.
        if (entry.isMeta) continue

        const msg = entry.message as { content: unknown } | undefined
        if (!msg) continue

        // ── Human-typed message (string content) → working ──
        // The user typed something, Claude will process it.
        if (typeof msg.content === 'string') {
          // Skip local command entries — these are slash commands (/login,
          // /plugin) and inline bash that run without invoking the LLM.
          // Claude Code writes them as type:"user" (inconsistently — /mcp and
          // /usage use type:"system"), but they're identifiable by XML tags.
          // They must be invisible to the state machine: if Claude was stopped
          // it stays stopped, if working it stays working.
          if (/^<(?:command-name|bash-input|local-command-(?:stdout|stderr|caveat)|bash-std(?:out|err))>/.test(msg.content)) {
            continue
          }
          this.transitionQueue.enqueue(surfaceId, 'working', 'jsonl', 'jsonl:user:string', entryTime)
          continue
        }

        // ── Array content = tool results ──
        if (Array.isArray(msg.content)) {
          const toolUseResult = entry.toolUseResult

          // ── User interrupted a tool ──
          // The "interrupted by user" text in toolUseResult means the user
          // pressed Ctrl+C or otherwise aborted. Claude stops processing.
          if (typeof toolUseResult === 'string' && toolUseResult.includes('interrupted by user')) {
            this.transitionQueue.enqueue(surfaceId, 'stopped', 'jsonl', 'jsonl:user:interrupt', entryTime)
            continue
          }

          // ── User rejected a permission prompt ──
          // Claude Code doesn't fire PostToolUse or PostToolUseFailure for
          // rejections, so the JSONL entry is our only signal. We default to
          // stopped because after a rejection, Claude either stops or continues
          // with a different approach — if it continues, jsonl:assistant will
          // correct the state to working.
          if (typeof toolUseResult === 'string' && toolUseResult.includes('rejected')) {
            this.transitionQueue.enqueue(surfaceId, 'stopped', 'jsonl', 'jsonl:user:rejected', entryTime)
            continue
          }

          // ── Content-based interrupt detection ──
          // Covers cases where toolUseResult is null but the entry content
          // carries the interrupt signal. This happens with the second entry
          // Claude Code writes after a permission rejection.
          const contentArr = msg.content as Array<{ type?: string; text?: string }>
          if (contentArr.some(item => item.type === 'text' && typeof item.text === 'string' && item.text.includes('interrupted by user'))) {
            this.transitionQueue.enqueue(surfaceId, 'stopped', 'jsonl', 'jsonl:user:interrupt:content', entryTime)
            continue
          }

          // Non-interrupt, non-rejection tool results: don't change state.
          // Hooks handle the working transition for normal tool completions
          // via PostToolUse. Changing state here would race with the hook.
        }
      }
    }
  }

  /**
   * Process a client write event (user typed something in the terminal).
   *
   * This handles Enter key presses (prompt submissions) and other interactions.
   * The key insight is that Enter from any non-stopped state should transition
   * to working, because the user is responding to Claude and Claude will
   * process the response.
   */
  handleClientWrite(surfaceId: string, isPromptSubmit: boolean): void {
    const wasUnread = this.deps.getClaudeStatusUnread(surfaceId)
    const prevState = this.deps.getClaudeState(surfaceId) ?? 'stopped'

    // Fast path: nothing to change.
    // If the indicator is not unread AND we're either not submitting a prompt
    // OR we're in stopped/stuck (where Enter is a no-op), skip all work.
    // Stuck is treated the same as stopped here — the user can't "unstick"
    // Claude by pressing Enter, they need to wait for Claude to recover or
    // restart the session.
    if (!wasUnread && (!isPromptSubmit || prevState === 'stopped' || prevState === 'stuck')) return

    // Any interaction clears the unread flag — the user has seen the terminal
    if (wasUnread) {
      this.deps.setClaudeStatusUnread(surfaceId, false)
    }

    let newState = prevState
    if (isPromptSubmit && prevState !== 'stopped' && prevState !== 'stuck') {
      // Enter from waiting_plan: user approved/responded to the plan
      // Enter from waiting_permission: user approved/denied the permission
      // Enter from working: stray keypress — Claude ignores it because
      //   Escape (not Enter) is the interrupt key. We still transition to
      //   'working' because it's a harmless no-op (already working) and
      //   the alternative (special-casing working) adds complexity for
      //   no benefit. The Stop hook handles actual stops.
      newState = 'working'
      this.deps.setClaudeState(surfaceId, 'working')
      this.deps.broadcastClaudeStateDecisionTime(surfaceId, Date.now())
    }

    this.decisionLogger.log(surfaceId, {
      timestamp: localISOTimestamp(),
      source: 'client',
      event: isPromptSubmit ? 'client:promptSubmit' : 'client:interact',
      prevState,
      newState,
      unread: false
    })
  }

  /**
   * Process a client request to mark/unmark a surface as read/unread.
   *
   * This is a direct user action (e.g. clicking the unread indicator)
   * and always succeeds — there's no business logic to guard against.
   */
  handleClientMarkUnread(surfaceId: string, unread: boolean): void {
    this.deps.setClaudeStatusUnread(surfaceId, unread)
    this.decisionLogger.log(surfaceId, {
      timestamp: localISOTimestamp(),
      source: 'client',
      event: unread ? 'client:markUnread' : 'client:markRead',
      prevState: this.deps.getClaudeState(surfaceId),
      newState: this.deps.getClaudeState(surfaceId),
      unread
    })
  }

  // ─── Core transition logic ──────────────────────────────────────────────

  /**
   * Apply a state transition after it's been dequeued from the transition queue.
   *
   * This is the single point where state actually changes. All guards and
   * side effects (unread flag, decision logging) are centralized here.
   */
  private applyTransition(
    surfaceId: string,
    newState: ClaudeState,
    source: 'hook' | 'jsonl' | 'status-line',
    event: string,
    detail?: string
  ): void {
    this.lastActivityBySurface.set(surfaceId, Date.now())
    const prevState = this.deps.getClaudeState(surfaceId) ?? 'stopped'

    this.deps.setClaudeState(surfaceId, newState)

    // ── Unread flag: set true when entering an attention-needed state ──
    // The user needs to see and act on stopped (Claude finished), waiting_permission
    // (Claude needs tool approval), waiting_question (Claude is asking a question),
    // and waiting_plan (Claude needs plan approval).
    // We only set unread on state *changes* to avoid re-flagging when the state
    // is set to the same value (e.g. multiple 'working' transitions in a row).
    let unread: boolean | undefined
    if (prevState !== newState) {
      if (newState === 'stopped' || newState === 'waiting_permission' || newState === 'waiting_question' || newState === 'waiting_plan') {
        unread = true
        this.deps.setClaudeStatusUnread(surfaceId, true)
      }
    }

    this.deps.broadcastClaudeStateDecisionTime(surfaceId, Date.now())

    this.decisionLogger.log(surfaceId, {
      timestamp: localISOTimestamp(),
      source,
      event,
      prevState,
      newState,
      detail,
      unread
    })
  }

  // ─── Stale sweep ──────────────────────────────────────────────────────────

  /**
   * Check for surfaces that have been in 'working' with no events for too long.
   *
   * Only transitions working → stuck (not other states like stopped or
   * waiting_permission). The reasoning:
   * - stopped/waiting_permission/waiting_question/waiting_plan: these are
   *   terminal states that require user action, not Claude activity — no events expected
   * - working: Claude should be producing events (hooks, JSONL entries,
   *   status-line heartbeats). If none arrive for 2 minutes, something
   *   is wrong — the process may have crashed, hung, or lost connectivity.
   *
   * We use 'stuck' instead of 'stopped' because stuck is recoverable:
   * if a delayed event arrives, the state machine transitions back to
   * working. Transitioning directly to stopped would be incorrect if
   * Claude is actually still running (just slow or backlogged).
   */
  private sweepStaleSurfaces(): void {
    const now = Date.now()
    for (const [surfaceId, lastActivity] of this.lastActivityBySurface) {
      if (now - lastActivity > STALE_WORKING_TIMEOUT_MS && this.deps.getClaudeState(surfaceId) === 'working') {
        this.deps.setClaudeState(surfaceId, 'stuck')
        this.deps.broadcastClaudeStateDecisionTime(surfaceId, now)
        this.deps.setClaudeStatusUnread(surfaceId, true)
        this.decisionLogger.log(surfaceId, {
          timestamp: localISOTimestamp(),
          source: 'stale',
          event: 'stale:timeout',
          prevState: 'working',
          newState: 'stuck',
          unread: true
        })
      }
    }
  }
}
