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
import { BackgroundLedger } from './background-ledger'
import { localISOTimestamp } from '../timestamp'

export { DecisionLogger } from './decision-logger'
export type { DecisionLogEntry } from './decision-logger'
export type { StateMachineDeps } from './types'

// ─── Background reconciliation sweep ────────────────────────────────────────

/**
 * How often (ms) to re-probe surfaces that are showing 'working_background'
 * (yellow) to see whether their outstanding launches have actually finished.
 *
 * This is the self-correction backstop: when a background task completes
 * without leaving a completion notification we can parse (e.g. it was killed,
 * or finished while the session sat idle), the liveness probe drains it and the
 * surface goes 'stopped'. 5s keeps the yellow→stopped latency small while the
 * probes (which only run for yellow surfaces with un-acked launches) stay cheap.
 *
 * Note: unlike the old stale sweep this replaces, this does NOT guess from
 * elapsed time — it verifies real OS/file state (lsof/pgrep/transcript tail).
 */
const BACKGROUND_RECONCILE_INTERVAL_MS = 5_000

/** Drain-to-idle transitions carry this suffix so applyTransition can gate them (see the guard there). */
const BG_DRAINED_SUFFIX = ':bg-drained'

// ─── ClaudeStateMachine ─────────────────────────────────────────────────────

export class ClaudeStateMachine {
  private deps: StateMachineDeps
  private decisionLogger: DecisionLogger
  private transitionQueue: TransitionQueue

  /**
   * Tracks work that outlives a turn (backgrounded subagents / bash / monitors
   * / workflows). Non-empty at Stop ⇒ the surface shows 'working_background'
   * (yellow) instead of 'stopped'. See background-ledger.ts.
   */
  private backgroundLedger: BackgroundLedger
  private reconcileSweepTimer: ReturnType<typeof setInterval> | null = null

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

  constructor(deps: StateMachineDeps, backgroundLedger: BackgroundLedger = new BackgroundLedger()) {
    this.deps = deps
    this.decisionLogger = new DecisionLogger()
    this.backgroundLedger = backgroundLedger
    this.transitionQueue = new TransitionQueue(
      (surfaceId, newState, source, event, detail) =>
        this.applyTransition(surfaceId, newState, source, event, detail)
    )
    // .catch keeps a probe failure from ever surfacing as an unhandled rejection
    // that could crash the server process.
    this.reconcileSweepTimer = setInterval(() => { this.reconcileBackgroundSurfaces().catch(() => {}) }, BACKGROUND_RECONCILE_INTERVAL_MS)
  }

  dispose(): void {
    if (this.reconcileSweepTimer) {
      clearInterval(this.reconcileSweepTimer)
      this.reconcileSweepTimer = null
    }
    // TransitionQueue.dispose() flushes remaining transitions before stopping
    this.transitionQueue.dispose()
  }

  /**
   * Test-only: apply all queued transitions immediately (bypassing the 500ms
   * ordering delay) so unit tests can assert final state synchronously. Runs
   * them in source-timestamp order, exactly as the real drain would.
   */
  flushForTest(): void {
    this.transitionQueue.drain(true)
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
    // Keep the background ledger's probe paths current: SubagentStart/Stop and
    // Stop all carry transcript_path + session_id. Cheap and idempotent.
    const transcriptPath = typeof payload?.transcript_path === 'string' ? payload.transcript_path : undefined
    const sessionId = typeof payload?.session_id === 'string' ? payload.session_id : undefined
    if (transcriptPath || sessionId) this.backgroundLedger.setContext(surfaceId, transcriptPath, sessionId)

    // Subagents fire their tool hooks (PreToolUse/PostToolUse/PreCompact) on the
    // MAIN agent's surface, tagged with agent_id. Those events are background
    // work, not the main agent — see the working-signals block, which ignores
    // them so a subagent's tool calls can't flip working_background (yellow)
    // back to working, or corrupt main-agent permission correlation. (Only
    // SubagentStart/SubagentStop use this agent_id, to drive the ledger.)
    const agentId = typeof payload?.agent_id === 'string' ? payload.agent_id : undefined

    // ── Stop: the main turn finished ──
    // If backgrounded work (subagents / bash / monitors / workflows) is still
    // outstanding, the session isn't truly idle — show 'working_background'
    // (yellow) instead of 'stopped'. When that work drains (SubagentStop, a
    // parsed completion, or a liveness probe) the surface goes 'stopped' and the
    // completion tone fires then — at the real end, not this premature Stop.
    // We still clear permission tracking (any pending permissions are moot) but
    // NOT the ledger (its work continues past this turn).
    if (hookType === 'Stop') {
      this.deps.handleClaudeStop(surfaceId)
      const outstanding = this.backgroundLedger.outstandingCount(surfaceId)
      this.transitionQueue.enqueue(
        surfaceId,
        outstanding > 0 ? 'working_background' : 'stopped',
        'hook',
        'hook:Stop',
        hookTime,
        outstanding > 0 ? `bg:${outstanding}` : undefined
      )
      this.pendingPermissionIds.delete(surfaceId)
      this.lastPreToolUseId.delete(surfaceId)
    }

    // ── SubagentStop: a backgrounded subagent finished ──
    // Drop it from the ledger; if that empties the ledger, drain to 'stopped'
    // (gated in applyTransition to only fire from 'working_background').
    if (hookType === 'SubagentStop') {
      if (agentId) this.backgroundLedger.completeAgent(surfaceId, agentId)
      this.drainBackgroundIfIdle(surfaceId, 'hook', `hook:SubagentStop${BG_DRAINED_SUFFIX}`, hookTime)
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
      // A PreToolUse/PreCompact carrying an agent_id is a SUBAGENT's own event,
      // fired on the main surface. It's background work — not the main agent —
      // so it must not drive main-surface state (that's what would flip yellow
      // back to orange while the main agent is idle), and it must not touch
      // lastPreToolUseId (which correlates MAIN-agent permission prompts).
      // SubagentStart also carries agent_id but legitimately means the main
      // agent spawned a subagent, so it stays a working signal + registers.
      if ((hookType === 'PreToolUse' || hookType === 'PreCompact') && agentId) {
        return
      }
      if (hookType === 'PreToolUse') {
        // Track the tool_use_id so PermissionRequest can associate it.
        // We overwrite any previous value because only the most recent
        // PreToolUse is relevant — older ones have already been handled.
        const toolUseId = payload?.tool_use_id
        if (typeof toolUseId === 'string') {
          this.lastPreToolUseId.set(surfaceId, toolUseId)
        }
      }
      if (hookType === 'SubagentStart') {
        // Register the backgrounded subagent so a Stop while it's running shows
        // yellow. Subagents are tracked via hooks (not transcript scraping)
        // because the hook's agent_id is authoritative and pairs cleanly with
        // SubagentStop.
        if (agentId) this.backgroundLedger.registerAgent(surfaceId, agentId)
      }
      if (hookType === 'UserPromptSubmit') {
        // A new user prompt invalidates all pending permissions — the user
        // is starting a fresh turn, so any unresolved permission requests
        // from the previous turn are stale.
        this.pendingPermissionIds.delete(surfaceId)
        this.lastPreToolUseId.delete(surfaceId)
        // A new turn also makes prior background context moot, and clearing the
        // ledger here bounds any leak from a missed completion to "until the
        // next prompt".
        this.backgroundLedger.clear(surfaceId)
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
      this.backgroundLedger.clear(surfaceId)
    }

    // ── SessionStart is intentionally NOT a state signal ──
    // It was previously special-cased: source === 'compact' → stopped, on the
    // assumption that after compaction Claude sits idle waiting for input. That
    // assumption is wrong: auto-compaction fires mid-turn (when the context
    // fills) and Claude resumes on its own a few seconds later. Across 42
    // historical compact events, EVERY one fired while 'working' and EVERY one
    // resumed to 'working' — the rule produced a spurious idle (tone + white
    // flash) 100% of the time and was never once correct. So we ignore
    // SessionStart entirely for state: a genuine idle is signalled by the Stop
    // hook, and a resume by the transcript's next assistant entry. (Session
    // lifecycle/history tracking still happens in the ingest handler.)
  }

  /**
   * Process a status-line event from Claude Code.
   *
   * Status-line events are periodic heartbeats that carry context-window usage
   * data (handled elsewhere). They no longer drive any state transition: with
   * the stale-sweep/'stuck' heuristic removed, there's nothing here to recover
   * from. Kept as a no-op so callers don't need to change.
   */
  handleStatusLine(_surfaceId: string): void {
    // intentionally empty — see doc comment
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

    // Feed the transcript to the background ledger first (launches, completions,
    // queued markers) so outstandingCount is current before any drain check below.
    this.backgroundLedger.ingestJsonl(surfaceId, entries)

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

          // ── User responded to a permission / plan / question ──
          // Claude Code writes a tool_result for every permission-gated tool
          // (ExitPlanMode → "User has approved your plan…", AskUserQuestion, and
          // ordinary tools), carrying the matching tool_use_id. This is the
          // reliable, transcript-based "user responded" signal that replaces the
          // old Enter-keypress (client:promptSubmit) path: many ExitPlanMode
          // approvals never fire a PostToolUse hook, so the transcript is the
          // only dependable clear for waiting_plan. It's checked AFTER the
          // interrupt/rejected cases above so those still win (→ stopped).
          const ids = this.pendingPermissionIds.get(surfaceId)
          if (ids && ids.size > 0) {
            for (const block of msg.content as Array<{ type?: string; tool_use_id?: unknown }>) {
              if (block && block.type === 'tool_result' && typeof block.tool_use_id === 'string' && ids.delete(block.tool_use_id)) {
                this.transitionQueue.enqueue(surfaceId, 'working', 'jsonl', 'jsonl:permission-resolved', entryTime)
                break
              }
            }
          }

          // Other non-interrupt, non-rejection tool results: don't change state.
          // Hooks handle the working transition for normal tool completions
          // via PostToolUse. Changing state here would race with the hook.
        }
      }
    }

    // A parsed completion notification may have drained the ledger — if the
    // surface is showing yellow and nothing's left, go idle now (rather than
    // waiting for the next reconciliation sweep).
    this.drainBackgroundIfIdle(surfaceId, 'jsonl', `jsonl:background${BG_DRAINED_SUFFIX}`, Date.now())
  }

  /**
   * Process a client interaction (the user typed something in the terminal).
   *
   * This ONLY clears the unread flag — the user has looked at the surface, so
   * it should stop glowing. It deliberately does NOT change claudeState.
   *
   * State is derived purely from hooks + transcript (like voiceop). The former
   * optimistic "Enter ⇒ working" transition was removed: the reliable clear for
   * a waiting state is now the tool_result written to the transcript when the
   * user responds (jsonl:permission-resolved), and a real prompt raises the
   * UserPromptSubmit hook. Mutating state from a raw keypress caused spurious
   * transitions (e.g. a stray Enter while working, or Enter that wasn't
   * actually a response).
   */
  handleClientInteract(surfaceId: string): void {
    if (!this.deps.getClaudeStatusUnread(surfaceId)) return
    this.deps.setClaudeStatusUnread(surfaceId, false)
    this.decisionLogger.log(surfaceId, {
      timestamp: localISOTimestamp(),
      source: 'client',
      event: 'client:interact',
      prevState: this.deps.getClaudeState(surfaceId),
      newState: this.deps.getClaudeState(surfaceId),
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

  /**
   * Process a client request to mark/unmark a surface as asleep.
   *
   * Asleep is a user-toggled flag that dims/hides a crab from navigation
   * without affecting the underlying claude state. Unlike unread (which auto-sets
   * on state transitions), asleep is purely manual.
   */
  handleClientMarkAsleep(surfaceId: string, asleep: boolean): void {
    this.deps.setClaudeStatusAsleep(surfaceId, asleep)
    this.decisionLogger.log(surfaceId, {
      timestamp: localISOTimestamp(),
      source: 'client',
      event: asleep ? 'client:markAsleep' : 'client:markAwake',
      prevState: this.deps.getClaudeState(surfaceId),
      newState: this.deps.getClaudeState(surfaceId),
      unread: false
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
    source: 'hook' | 'jsonl' | 'status-line' | 'ledger',
    event: string,
    detail?: string
  ): void {
    const prevState = this.deps.getClaudeState(surfaceId) ?? 'stopped'

    // ── Guard: background drain-to-idle only fires from 'working_background' ──
    // A ':bg-drained' transition is enqueued whenever the ledger empties, from
    // whichever event observed the last completion. It must only take effect
    // when the surface is actually showing yellow — otherwise (e.g. the agent
    // resumed to 'working', or a Stop already resolved to 'stopped') it would
    // wrongly force 'stopped'. Gating here (rather than at enqueue time) makes
    // it correct regardless of hook/queue ordering: the yellow-inducing Stop and
    // the drain are ordered by source timestamp, so by the time a legitimate
    // drain is applied, 'working_background' is the prevState.
    if (event.endsWith(BG_DRAINED_SUFFIX) && prevState !== 'working_background') {
      this.decisionLogger.log(surfaceId, {
        timestamp: localISOTimestamp(), source, event, prevState, newState: prevState, detail, suppressed: true
      })
      return
    }

    // ── Guard: only targeted signals can exit waiting states to working ──
    // Waiting states are "sticky" — most working signals are suppressed.
    // Two categories of untargeted signals would incorrectly clear them:
    //
    // 1. Hook working signals (PreToolUse, SubagentStart, PreCompact):
    //    Subagent events fire on the same surface as the main agent. If the
    //    main agent is waiting for permission and a subagent runs tools, the
    //    subagent's PreToolUse would incorrectly clear waiting_permission.
    //    Analysis of 607 decision logs found 61 occurrences of this bug
    //    across 22 sessions, with zero counterexamples.
    //
    // 2. JSONL working signals (jsonl:assistant, jsonl:user:string):
    //    Parallel tool_use blocks in a single response produce JSONL entries
    //    AFTER the PermissionRequest hook, which would clobber waiting → working.
    //
    // Only these targeted signals can clear waiting → working:
    // - hook:PostToolUse/PostToolUseFailure (ID-matched: permission resolved)
    // - hook:UserPromptSubmit (user started a new turn)
    // - jsonl:permission-resolved (the transcript wrote the tool_result for the
    //   pending permission tool_use_id — the reliable, hook-independent clear
    //   that replaced the old client:promptSubmit Enter-keypress path)
    // Other exits from waiting states use newState !== 'working' (e.g.
    // Stop → stopped, jsonl:user:rejected → stopped) and bypass this guard.
    const isWaitingState = prevState === 'waiting_permission' || prevState === 'waiting_question' || prevState === 'waiting_plan'
    if (isWaitingState && newState === 'working') {
      const canClearWaiting =
        event === 'hook:UserPromptSubmit' ||
        event === 'hook:PostToolUse' ||
        event === 'hook:PostToolUseFailure' ||
        event === 'jsonl:permission-resolved'
      if (!canClearWaiting) {
        this.decisionLogger.log(surfaceId, {
          timestamp: localISOTimestamp(),
          source,
          event,
          prevState,
          newState: prevState,
          detail,
          suppressed: true
        })
        return
      }
    }

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

  // ─── Background drain / reconciliation ──────────────────────────────────────

  /**
   * If the surface is (or is about to be) showing 'working_background' and its
   * ledger is now empty, enqueue a drain-to-idle transition. The transition is
   * gated in applyTransition so it only takes effect from 'working_background'
   * (see BG_DRAINED_SUFFIX there), which is why we can enqueue it unconditionally
   * whenever the ledger empties without racing the yellow-inducing Stop.
   */
  private drainBackgroundIfIdle(
    surfaceId: string,
    source: 'hook' | 'jsonl' | 'ledger',
    event: string,
    time: number
  ): void {
    if (this.backgroundLedger.outstandingCount(surfaceId) === 0) {
      this.transitionQueue.enqueue(surfaceId, 'stopped', source, event, time)
    }
  }

  /**
   * Periodic self-correction: re-probe each yellow surface's outstanding
   * launches (lsof/pgrep/transcript-tail/state-file) and, if they've all
   * actually finished, drain to 'stopped'. This is the backstop for completions
   * we never see in the transcript (killed tasks, work that finished while the
   * session sat idle). Only yellow surfaces are probed, so it's cheap otherwise.
   */
  private async reconcileBackgroundSurfaces(): Promise<void> {
    for (const surfaceId of this.backgroundLedger.activeSurfaces()) {
      if (this.deps.getClaudeState(surfaceId) !== 'working_background') continue
      const pruned = await this.backgroundLedger.reconcile(surfaceId)
      if (pruned) {
        this.drainBackgroundIfIdle(surfaceId, 'ledger', `ledger:reconcile${BG_DRAINED_SUFFIX}`, Date.now())
      }
    }
  }
}
