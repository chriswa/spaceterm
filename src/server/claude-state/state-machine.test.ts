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
    name: 'UserPromptSubmit clears the ledger — a later Stop is not yellow',
    run: (sm, deps) => {
      hook(sm, 'UserPromptSubmit')
      hook(sm, 'SubagentStart', { agent_id: 'a1' })
      hook(sm, 'Stop')
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'working_background')
      hook(sm, 'UserPromptSubmit')     // new turn — clears ledger
      hook(sm, 'Stop')
      sm.flushForTest()
      assertEq(deps.getClaudeState(S), 'stopped')
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
