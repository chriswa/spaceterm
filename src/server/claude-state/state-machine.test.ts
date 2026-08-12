import { describe, it } from 'vitest'
import { ClaudeStateMachine } from './index'
import { BackgroundLedger } from './background-ledger'
import type { StateMachineDeps, ClaudeState } from './types'
import type { SessionFileEntry } from '../session-file-watcher'
import { asPtySessionId as pid, asClaudeSessionId as cid } from '../../shared/ids'

/**
 * Tests for the ClaudeStateMachine transitions introduced with the yellow
 * 'working_background' state and the transcript-based permission-resolution
 * that replaced the client Enter-keypress path.
 *
 * Transitions go through a 500ms ordering queue in production; tests use
 * flushForTest() to apply them synchronously in source-timestamp order.
 *
 * Run with: npm test
 */

const S = pid('surface-1')

class FakeDeps implements StateMachineDeps {
  state = new Map<string, ClaudeState>()
  unread = new Map<string, boolean>()
  /** Surfaces whose scrollback shows a stopped API error. */
  potentialErrors = new Set<string>()
  getClaudeState(id: string): ClaudeState { return this.state.get(id) ?? 'stopped' }
  setClaudeState(id: string, s: ClaudeState): void { this.state.set(id, s) }
  hasPotentialError(id: string): boolean { return this.potentialErrors.has(id) }
  getClaudeStatusUnread(id: string): boolean { return this.unread.get(id) ?? false }
  setClaudeStatusUnread(id: string, u: boolean): void { this.unread.set(id, u) }
  handleClaudeStop(): void { /* no-op */ }
  broadcastClaudeStateDecisionTime(): void { /* no-op */ }
  setClaudeStatusAsleep(): void { /* no-op */ }
}

/** Monotonic clock so queued transitions apply in the order events were fired. */
let clock = 0
const now = () => ++clock

function hook(sm: ClaudeStateMachine, type: string, payload: Record<string, unknown> = {}): void {
  sm.handleHook(S, type, { session_id: 'sess', transcript_path: '/p/sess.jsonl', ...payload }, now())
}
function jsonl(sm: ClaudeStateMachine, entries: SessionFileEntry[]): void {
  const stamped = entries.map(e => ({ timestamp: new Date(now()).toISOString(), ...e }))
  sm.handleJsonlEntries(S, stamped, false)
}
function toolResult(toolUseId: string, text = 'ok'): SessionFileEntry {
  return { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] } }
}

interface Case { name: string; run: (sm: ClaudeStateMachine, deps: FakeDeps) => void }

const cases: Case[] = [
  {
    // The upgrade used to happen in index.ts, downstream of here, by
    // re-entering setClaudeState from its own callback — so potential_error was
    // the one ClaudeState value that never appeared in the decision log.
    name: 'Stop with a detected API error → potential_error (+unread)',
    run: (sm, deps) => {
      deps.potentialErrors.add(S)
      hook(sm, 'UserPromptSubmit')
      hook(sm, 'Stop')
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'potential_error')
      assertEq(deps.getClaudeStatusUnread(S), true)
    },
  },
  {
    name: 'API error does not upgrade a state other than stopped',
    run: (sm, deps) => {
      deps.potentialErrors.add(S)
      hook(sm, 'UserPromptSubmit')
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'working')
    },
  },
  {
    name: 'no detected error leaves stopped alone',
    run: (sm, deps) => {
      hook(sm, 'UserPromptSubmit')
      hook(sm, 'Stop')
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'stopped')
    },
  },
  {
    name: 'Stop with no background work → stopped (+unread)',
    run: (sm, deps) => {
      hook(sm, 'UserPromptSubmit')
      hook(sm, 'Stop')
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'stopped')
      assertEq(deps.getClaudeStatusUnread(S), true)
    },
  },
  {
    name: 'Stop with a running background subagent → working_background (no unread)',
    run: (sm, deps) => {
      hook(sm, 'UserPromptSubmit')
      hook(sm, 'SubagentStart', { agent_id: 'a1' })
      hook(sm, 'Stop')
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'working_background')
      assertEq(deps.getClaudeStatusUnread(S), false)
    },
  },
  {
    name: 'SubagentStop draining the last subagent → stopped (+unread, tone fires here)',
    run: (sm, deps) => {
      hook(sm, 'UserPromptSubmit')
      hook(sm, 'SubagentStart', { agent_id: 'a1' })
      hook(sm, 'Stop')
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'working_background')
      hook(sm, 'SubagentStop', { agent_id: 'a1' })
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'stopped')
      assertEq(deps.getClaudeStatusUnread(S), true)
    },
  },
  {
    name: 'one of two subagents stopping stays yellow until both finish',
    run: (sm, deps) => {
      hook(sm, 'UserPromptSubmit')
      hook(sm, 'SubagentStart', { agent_id: 'a1' })
      hook(sm, 'SubagentStart', { agent_id: 'a2' })
      hook(sm, 'Stop')
      hook(sm, 'SubagentStop', { agent_id: 'a1' })
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'working_background')
      hook(sm, 'SubagentStop', { agent_id: 'a2' })
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'stopped')
    },
  },
  {
    name: 'yellow stays yellow while a subagent runs tools (subagent PreToolUse ignored)',
    run: (sm, deps) => {
      hook(sm, 'UserPromptSubmit')
      hook(sm, 'SubagentStart', { agent_id: 'a1' })
      hook(sm, 'Stop')
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'working_background')
      // The subagent keeps calling tools on the main surface — these carry
      // agent_id and must NOT flip the idle main agent back to orange.
      hook(sm, 'PreToolUse', { agent_id: 'a1', tool_use_id: 'sub-tool-1' })
      hook(sm, 'PreToolUse', { agent_id: 'a1', tool_use_id: 'sub-tool-2' })
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'working_background')
    },
  },
  {
    name: 'yellow → working when the MAIN agent resumes (PreToolUse without agent_id)',
    run: (sm, deps) => {
      hook(sm, 'UserPromptSubmit')
      hook(sm, 'SubagentStart', { agent_id: 'a1' })
      hook(sm, 'Stop')
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'working_background')
      hook(sm, 'PreToolUse', { tool_use_id: 'main-tool' }) // no agent_id → main agent
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'working')
    },
  },
  {
    name: 'yellow + assistant output → working (agent resumed on its own)',
    run: (sm, deps) => {
      hook(sm, 'UserPromptSubmit')
      hook(sm, 'SubagentStart', { agent_id: 'a1' })
      hook(sm, 'Stop')
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'working_background')
      jsonl(sm, [{ type: 'assistant' }])
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'working')
    },
  },
  {
    name: 'typed UserPromptSubmit clears the ledger — a later Stop is not yellow',
    run: (sm, deps) => {
      hook(sm, 'UserPromptSubmit', { prompt: 'keep going' })
      hook(sm, 'SubagentStart', { agent_id: 'a1' })
      hook(sm, 'Stop')
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'working_background')
      hook(sm, 'UserPromptSubmit', { prompt: 'ok next' })     // typed turn — clears ledger
      hook(sm, 'Stop')
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'stopped')
    },
  },
  {
    // Regression: a persistent monitor's per-event ping arrives as
    // UserPromptSubmit with a <task-notification> body (no <status>). That used
    // to clear the ledger, so the wake turn's Stop went to stopped/white while
    // the monitor was still armed.
    name: 'task-notification UserPromptSubmit does not clear the ledger',
    run: (sm, deps) => {
      hook(sm, 'UserPromptSubmit', { prompt: 'watch that' })
      jsonl(sm, [toolResult('tuM', 'Monitor started (task mon12345)')])
      hook(sm, 'Stop')
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'working_background')
      hook(sm, 'UserPromptSubmit', {
        prompt:
          '<task-notification>\n' +
          '<task-id>mon12345</task-id>\n' +
          '<summary>Monitor event: "x"</summary>\n' +
          '<event>still running</event>\n' +
          '</task-notification>',
      })
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'working')
      hook(sm, 'Stop')
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'working_background')
    },
  },
  {
    // Completions also arrive as task-notification UserPromptSubmits. Clearing
    // on those would drop sibling outstanding work; the jsonl path drains the
    // finished id specifically.
    name: 'task-notification completion UserPromptSubmit keeps sibling ledger entries',
    run: (sm, deps) => {
      hook(sm, 'UserPromptSubmit', { prompt: 'run both' })
      hook(sm, 'SubagentStart', { agent_id: 'a1' })
      jsonl(sm, [toolResult('tuB', 'Command running in background with ID: bash99. Output is being written to: /tmp/bash99.output')])
      hook(sm, 'Stop')
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'working_background')
      hook(sm, 'UserPromptSubmit', {
        prompt:
          '<task-notification>\n' +
          '<task-id>bash99</task-id>\n' +
          '<status>completed</status>\n' +
          '<summary>Background command done</summary>\n' +
          '</task-notification>',
      })
      // No jsonl ingest of the completion — only the hook. Sibling subagent
      // must still keep the surface yellow after this wake turn ends.
      hook(sm, 'Stop')
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'working_background')
    },
  },
  {
    name: 'jsonl:permission-resolved clears waiting_plan (no PostToolUse needed)',
    run: (sm, deps) => {
      hook(sm, 'UserPromptSubmit')
      hook(sm, 'PreToolUse', { tool_use_id: 'tu1' })
      hook(sm, 'PermissionRequest', { tool_name: 'ExitPlanMode' })
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'waiting_plan')
      jsonl(sm, [toolResult('tu1', 'User has approved your plan.')])
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'working')
    },
  },
  {
    name: 'jsonl:permission-resolved clears waiting_question',
    run: (sm, deps) => {
      hook(sm, 'UserPromptSubmit')
      hook(sm, 'PreToolUse', { tool_use_id: 'tuQ' })
      hook(sm, 'PermissionRequest', { tool_name: 'AskUserQuestion' })
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'waiting_question')
      jsonl(sm, [toolResult('tuQ')])
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'working')
    },
  },
  {
    name: 'a non-matching tool_result does NOT clear a waiting state',
    run: (sm, deps) => {
      hook(sm, 'UserPromptSubmit')
      hook(sm, 'PreToolUse', { tool_use_id: 'tu1' })
      hook(sm, 'PermissionRequest', { tool_name: 'ExitPlanMode' })
      sm.flushForTest()
      jsonl(sm, [toolResult('some-other-id')])
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'waiting_plan')
    },
  },
  {
    name: 'mid-turn auto-compaction (SessionStart:compact) does NOT flip to stopped',
    run: (sm, deps) => {
      hook(sm, 'UserPromptSubmit')
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'working')
      // Context fills mid-turn → Claude auto-compacts and resumes. This must not
      // register as idle (no tone, no white flash).
      hook(sm, 'SessionStart', { source: 'compact' })
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'working')
      assertEq(deps.getClaudeStatusUnread(S), false)
    },
  },
  {
    // A user-typed /compact runs for minutes and hands the prompt back with no
    // Stop hook, so the surface used to sit orange until the user next typed.
    // The local command's own stdout entry is what closes it out.
    name: 'finished manual /compact → stopped (+unread, tone fires)',
    run: (sm, deps) => {
      hook(sm, 'PreCompact', { trigger: 'manual' })
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'working')
      jsonl(sm, [{ type: 'user', message: { content: '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>' } }])
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'stopped')
      assertEq(deps.getClaudeStatusUnread(S), true)
    },
  },
  {
    // Compaction does not stop backgrounded work, so the surface owes the user
    // yellow, not the completion tone.
    name: 'finished manual /compact with background work → working_background',
    run: (sm, deps) => {
      hook(sm, 'UserPromptSubmit', { prompt: 'go' })
      hook(sm, 'SubagentStart', { agent_id: 'a1' })
      hook(sm, 'PreCompact', { trigger: 'manual' })
      jsonl(sm, [{ type: 'user', message: { content: '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>' } }])
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'working_background')
      assertEq(deps.getClaudeStatusUnread(S), false)
    },
  },
  {
    // Auto-compaction fires mid-turn and Claude resumes on its own; it is not a
    // local command, so nothing may close it out as idle.
    name: 'auto-compaction stdout lookalike does not idle the surface',
    run: (sm, deps) => {
      hook(sm, 'UserPromptSubmit')
      hook(sm, 'PreCompact', { trigger: 'auto' })
      jsonl(sm, [{ type: 'user', message: { content: '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>' } }])
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'working')
      assertEq(deps.getClaudeStatusUnread(S), false)
    },
  },
  {
    // The flag is single-use: a second, unrelated local command later in the
    // session must not replay the idle.
    name: 'manual-compact flag is consumed once',
    run: (sm, deps) => {
      // Also pins the deliberate wording-independence: the "Compacted…" prose is
      // version-dependent and has no probe behind it, so the manual-specific
      // evidence is the hook's `trigger` field, not this text.
      hook(sm, 'PreCompact', { trigger: 'manual' })
      jsonl(sm, [{ type: 'user', message: { content: '<local-command-stdout>(some future wording)</local-command-stdout>' } }])
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'stopped')
      hook(sm, 'UserPromptSubmit', { prompt: 'next' })
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'working')
      jsonl(sm, [{ type: 'user', message: { content: '<local-command-stdout>Compacted</local-command-stdout>' } }])
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'working')
    },
  },
  {
    // No Notification kind drives state. idle_prompt in particular was evaluated
    // as a backstop for turns ending without a Stop and rejected: it is Claude
    // Code's generic "needs your attention at the prompt" signal, so an attention
    // state we don't model would arrive here as 'working' (past the waiting-state
    // guard) and get relabelled a plain completion — white + tone over the real
    // reason. Everything it would have caught is covered by the watermark
    // (invariant 16) and compact-finished.
    name: 'Notification hooks do not drive state (any kind)',
    run: (sm, deps) => {
      hook(sm, 'UserPromptSubmit')
      sm.flushForTest()
      for (const kind of ['idle_prompt', 'permission_prompt', 'auth_success']) {
        hook(sm, 'Notification', { notification_type: kind, message: 'Claude is waiting for your input' })
      }
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'working')
      assertEq(deps.getClaudeStatusUnread(S), false)
    },
  },
  {
    // The stuck-orange bug: Claude wrote its final assistant message, the Stop
    // hook fired 544ms later (already outside the queue's 500ms window), and the
    // JSONL watcher delivered that assistant entry ~1.4s after it was written.
    // Stop applied first, then the stale entry applied out of order and put the
    // surface back to 'working' — with the turn over, nothing ever corrected it.
    name: 'a JSONL entry delivered after the Stop it predates does not resurrect working',
    run: (sm, deps) => {
      hook(sm, 'UserPromptSubmit')
      const finalMessageTime = now()   // Claude wrote its last message here…
      hook(sm, 'Stop')                 // …and the Stop hook fired after it
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'stopped')
      // Only now does the watcher deliver the assistant entry. It is already
      // past the delay cutoff, so it drains alone, out of order.
      jsonl(sm, [{ type: 'assistant', timestamp: new Date(finalMessageTime).toISOString() }])
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'stopped')
      assertEq(deps.getClaudeStatusUnread(S), true)
      // …and the watermark must not wedge the surface: the next real event lands.
      hook(sm, 'UserPromptSubmit')
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'working')
    },
  },
  {
    // The watermark must never become a fifth way for a waiting state to get
    // stuck: those states have no self-correcting sweep behind them.
    name: 'a late-delivered permission-resolved still clears waiting_plan',
    run: (sm, deps) => {
      hook(sm, 'UserPromptSubmit')
      hook(sm, 'PreToolUse', { tool_use_id: 'tu1' })
      const approvalTime = now()
      hook(sm, 'PermissionRequest', { tool_name: 'ExitPlanMode' })
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'waiting_plan')
      jsonl(sm, [{ ...toolResult('tu1', 'User has approved your plan.'), timestamp: new Date(approvalTime).toISOString() }])
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'working')
    },
  },
  {
    name: 'an assistant entry newer than the Stop still resumes working',
    run: (sm, deps) => {
      hook(sm, 'UserPromptSubmit')
      hook(sm, 'Stop')
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'stopped')
      // Claude resumed on its own (e.g. after auto-compaction) — this entry is
      // genuinely later than the Stop, so it must win.
      jsonl(sm, [{ type: 'assistant' }])
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'working')
    },
  },
  {
    name: 'a stray bg-drained is suppressed when not yellow (stays working)',
    run: (sm, deps) => {
      hook(sm, 'UserPromptSubmit')
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'working')
      // A completion notification for nothing we track → ledger empty → a
      // bg-drained 'stopped' is enqueued, but must be suppressed from 'working'.
      jsonl(sm, [{ type: 'user', message: { content: '<task-notification><task-id>zzz</task-id><status>completed</status></task-notification>' } }])
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'working')
    },
  },
]

function assertEq(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

describe('ClaudeStateMachine transitions', () => {
  for (const c of cases) {
    it(c.name, () => {
      // Each case gets a fresh machine + monotonic clock so queued transitions
      // apply in the order the case fired them, independent of other cases.
      clock = 0
      const deps = new FakeDeps()
      const sm = new ClaudeStateMachine(deps, new BackgroundLedger())
      try {
        c.run(sm, deps)
      } finally {
        sm.dispose()
      }
    })
  }
})
