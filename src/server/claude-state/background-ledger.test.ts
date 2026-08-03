import { describe, it } from 'vitest'
import { BackgroundLedger, agentTranscriptVerdict, type LivenessProbes, type LivenessVerdict } from './background-ledger'
import type { SessionFileEntry } from '../session-file-watcher'
import { asPtySessionId, asPtySessionId as pid, asClaudeSessionId as cid } from '../../shared/ids'

/**
 * Tests for the background-work ledger — the launch/completion parsing and the
 * liveness-probe reconciliation that decide whether a surface is still
 * "finishing background work" (yellow) after its turn ends.
 *
 * Run with: npm test
 */

const SURFACE = asPtySessionId('surface-1')

// Probes we can steer per-test. Default: everything still running (fail-safe).
type ProbeKind = 'bash' | 'monitor' | 'agent' | 'workflow'
function fakeProbes(overrides: Partial<Record<ProbeKind, LivenessVerdict | (() => LivenessVerdict)>> = {}): LivenessProbes {
  // A thunk lets a test change a probe's answer between sweeps.
  const answer = (kind: ProbeKind): LivenessVerdict => {
    const o = overrides[kind] ?? 'running'
    return typeof o === 'function' ? o() : o
  }
  return {
    probeBash: async () => answer('bash'),
    probeMonitor: async () => answer('monitor'),
    probeAgent: async () => answer('agent'),
    probeWorkflow: async () => answer('workflow'),
  }
}

/** One JSONL line of a subagent transcript. */
const line = (o: unknown) => JSON.stringify(o)
const assistantLine = (stopReason: string) => line({ type: 'assistant', message: { stop_reason: stopReason, content: [] } })
const interruptLine = (text = '[Request interrupted by user]') => line({ type: 'user', message: { content: [{ type: 'text', text }] } })
const toolResultLine = (text: string) => line({ type: 'user', message: { content: [{ type: 'tool_result', content: text }] } })

/** A transcript user-entry whose single tool_result carries the given text. */
function toolResultEntry(text: string): SessionFileEntry {
  return { type: 'user', message: { content: [{ type: 'tool_result', content: text }] } }
}

/** A plain string-content entry (used for injected notifications). */
function stringEntry(type: string, content: string): SessionFileEntry {
  return { type, message: { content } }
}

interface Case { name: string; run: () => Promise<void> | void }

const BASH_ACK = 'Command running in background with ID: b4g2uhdde. Output is being written to: /tmp/claude/x.output'
const DONE = (id: string) => `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n</task-notification>`

const cases: Case[] = [
  {
    name: 'bash launch ack registers one outstanding launch',
    run: () => {
      const l = new BackgroundLedger(fakeProbes())
      l.ingestJsonl(SURFACE, [toolResultEntry(BASH_ACK)])
      assertEq(l.outstandingCount(SURFACE), 1)
    },
  },
  {
    name: 'bash completion notification drains it',
    run: () => {
      const l = new BackgroundLedger(fakeProbes())
      l.ingestJsonl(SURFACE, [toolResultEntry(BASH_ACK)])
      l.ingestJsonl(SURFACE, [stringEntry('user', DONE('b4g2uhdde'))])
      assertEq(l.outstandingCount(SURFACE), 0)
    },
  },
  {
    name: 'completion without <status> does not drain (monitor per-event ping)',
    run: () => {
      const l = new BackgroundLedger(fakeProbes())
      l.ingestJsonl(SURFACE, [toolResultEntry(BASH_ACK)])
      l.ingestJsonl(SURFACE, [stringEntry('user', '<task-id>b4g2uhdde</task-id> event fired')])
      assertEq(l.outstandingCount(SURFACE), 1)
    },
  },
  {
    name: 'completion on an assistant entry is ignored',
    run: () => {
      const l = new BackgroundLedger(fakeProbes())
      l.ingestJsonl(SURFACE, [toolResultEntry(BASH_ACK)])
      l.ingestJsonl(SURFACE, [stringEntry('assistant', DONE('b4g2uhdde'))])
      assertEq(l.outstandingCount(SURFACE), 1)
    },
  },
  {
    name: 'monitor launch ack (no timeout form) registers',
    run: () => {
      const l = new BackgroundLedger(fakeProbes())
      l.ingestJsonl(SURFACE, [toolResultEntry('Monitor started (task mon12345)')])
      assertEq(l.outstandingCount(SURFACE), 1)
    },
  },
  {
    name: 'workflow requires BOTH task id and run id',
    run: () => {
      const l = new BackgroundLedger(fakeProbes())
      l.ingestJsonl(SURFACE, [toolResultEntry('Workflow launched in background. Task ID: wf9')]) // no Run ID
      assertEq(l.outstandingCount(SURFACE), 0)
      l.ingestJsonl(SURFACE, [toolResultEntry('Workflow launched in background. Task ID: wf9. Run ID: wf_abc-123')])
      assertEq(l.outstandingCount(SURFACE), 1)
    },
  },
  {
    name: 'queue-operation enqueue keeps launch outstanding (work done, not yet delivered)',
    run: () => {
      const l = new BackgroundLedger(fakeProbes())
      l.ingestJsonl(SURFACE, [toolResultEntry(BASH_ACK)])
      l.ingestJsonl(SURFACE, [{ type: 'queue-operation', operation: 'enqueue', content: DONE('b4g2uhdde') }])
      assertEq(l.outstandingCount(SURFACE), 1)
    },
  },
  {
    name: 'assistant/prose mentioning the phrase does not register (only tool_result is scanned)',
    run: () => {
      const l = new BackgroundLedger(fakeProbes())
      l.ingestJsonl(SURFACE, [stringEntry('assistant', BASH_ACK)])
      assertEq(l.outstandingCount(SURFACE), 0)
    },
  },
  {
    name: 'registerAgent / completeAgent via hooks',
    run: () => {
      const l = new BackgroundLedger(fakeProbes())
      l.registerAgent(SURFACE, 'acc222d')
      l.registerAgent(SURFACE, 'a90e33d')
      assertEq(l.outstandingCount(SURFACE), 2)
      l.completeAgent(SURFACE, 'acc222d')
      assertEq(l.outstandingCount(SURFACE), 1)
    },
  },
  {
    name: 'UserPromptSubmit-style clear() empties the ledger',
    run: () => {
      const l = new BackgroundLedger(fakeProbes())
      l.ingestJsonl(SURFACE, [toolResultEntry(BASH_ACK)])
      l.clear(SURFACE)
      assertEq(l.outstandingCount(SURFACE), 0)
    },
  },
  {
    name: 'reconcile drains a bash launch once lsof says finished',
    run: async () => {
      const l = new BackgroundLedger(fakeProbes({ bash: 'running' }))
      l.ingestJsonl(SURFACE, [toolResultEntry(BASH_ACK)])
      assertEq(await l.reconcile(SURFACE), false) // still running
      assertEq(l.outstandingCount(SURFACE), 1)

      const l2 = new BackgroundLedger(fakeProbes({ bash: 'finished' }))
      l2.ingestJsonl(SURFACE, [toolResultEntry(BASH_ACK)])
      assertEq(await l2.reconcile(SURFACE), true) // finished → pruned
      assertEq(l2.outstandingCount(SURFACE), 0)
    },
  },
  {
    name: 'reconcile never probes a queued launch',
    run: async () => {
      // bash probe says "finished", but the launch is queued → must stay outstanding.
      const l = new BackgroundLedger(fakeProbes({ bash: 'finished' }))
      l.ingestJsonl(SURFACE, [toolResultEntry(BASH_ACK)])
      l.ingestJsonl(SURFACE, [{ type: 'queue-operation', operation: 'enqueue', content: DONE('b4g2uhdde') }])
      assertEq(await l.reconcile(SURFACE), false)
      assertEq(l.outstandingCount(SURFACE), 1)
    },
  },

  // ── Notification delivery: the queue's exit op drains the launch ──
  {
    name: 'a queue-operation remove drains the launch it delivered',
    run: () => {
      // The live failure: four background Bash launches enqueued completions,
      // each removed ~2s later, and the remove op was skipped entirely — so
      // they stayed queued, unprobed and immortal.
      const l = new BackgroundLedger(fakeProbes())
      l.ingestJsonl(SURFACE, [toolResultEntry(BASH_ACK)])
      l.ingestJsonl(SURFACE, [{ type: 'queue-operation', operation: 'enqueue', content: DONE('b4g2uhdde') }])
      assertEq(l.outstandingCount(SURFACE), 1)
      l.ingestJsonl(SURFACE, [{ type: 'queue-operation', operation: 'remove', content: DONE('b4g2uhdde') }])
      assertEq(l.outstandingCount(SURFACE), 0)
    },
  },
  {
    name: 'a queue-operation remove still drains a launch we never saw enqueued',
    run: () => {
      const l = new BackgroundLedger(fakeProbes())
      l.ingestJsonl(SURFACE, [toolResultEntry(BASH_ACK)])
      l.ingestJsonl(SURFACE, [{ type: 'queue-operation', operation: 'remove', content: DONE('b4g2uhdde') }])
      assertEq(l.outstandingCount(SURFACE), 0)
    },
  },
  {
    name: 'a queue-operation without <status> drains nothing',
    run: () => {
      const l = new BackgroundLedger(fakeProbes())
      l.ingestJsonl(SURFACE, [toolResultEntry(BASH_ACK)])
      l.ingestJsonl(SURFACE, [{ type: 'queue-operation', operation: 'remove', content: '<task-id>b4g2uhdde</task-id> ping' }])
      assertEq(l.outstandingCount(SURFACE), 1)
    },
  },
  {
    name: 'a queued launch whose delivery is never parsed drains at the staleness bound',
    run: async () => {
      // The invariant: no launch is exempt from EVERY drain path. Skipping the
      // probe must not also skip the clock.
      const l = new BackgroundLedger(fakeProbes({ bash: 'finished' }))
      l.ingestJsonl(SURFACE, [toolResultEntry(BASH_ACK)])
      l.ingestJsonl(SURFACE, [{ type: 'queue-operation', operation: 'enqueue', content: DONE('b4g2uhdde') }], 1_000)
      assertEq(await l.reconcile(SURFACE, 1_000 + 60_000), false)     // normal delivery latency: seconds
      assertEq(l.outstandingCount(SURFACE), 1)
      assertEq(await l.reconcile(SURFACE, 1_000 + 5 * 60_000), true)  // nothing is coming
      assertEq(l.outstandingCount(SURFACE), 0)
    },
  },
  {
    name: 're-enqueue does not restart the queued clock',
    run: async () => {
      // Otherwise a repeated enqueue for the same id would push the bound out
      // forever, restoring the immortality this replaced.
      const l = new BackgroundLedger(fakeProbes())
      l.ingestJsonl(SURFACE, [toolResultEntry(BASH_ACK)])
      const enqueue = [{ type: 'queue-operation', operation: 'enqueue', content: DONE('b4g2uhdde') }]
      l.ingestJsonl(SURFACE, enqueue, 0)
      l.ingestJsonl(SURFACE, enqueue, 4 * 60_000)
      assertEq(await l.reconcile(SURFACE, 5 * 60_000), true)
    },
  },

  // ── Staleness bound: 'indeterminate' cannot pin the indicator forever ──
  {
    name: 'an indeterminate launch survives well past the sweep interval',
    run: async () => {
      const l = new BackgroundLedger(fakeProbes({ bash: 'indeterminate' }))
      l.ingestJsonl(SURFACE, [toolResultEntry(BASH_ACK)])
      assertEq(await l.reconcile(SURFACE, 0), false)
      assertEq(await l.reconcile(SURFACE, 60_000), false)
      assertEq(await l.reconcile(SURFACE, 4 * 60_000), false)
      assertEq(l.outstandingCount(SURFACE), 1)
    },
  },
  {
    name: 'an indeterminate launch drains once the staleness bound elapses',
    run: async () => {
      const l = new BackgroundLedger(fakeProbes({ bash: 'indeterminate' }))
      l.ingestJsonl(SURFACE, [toolResultEntry(BASH_ACK)])
      assertEq(await l.reconcile(SURFACE, 1_000), false)
      assertEq(await l.reconcile(SURFACE, 1_000 + 5 * 60_000), true)
      assertEq(l.outstandingCount(SURFACE), 0)
    },
  },
  {
    name: 'a definite "running" resets the staleness clock, so long work never drains',
    run: async () => {
      // The regression this guards: if 'running' accrued toward the bound like
      // 'indeterminate' does, every workflow longer than five minutes would
      // fire the completion tone mid-run.
      let verdict: LivenessVerdict = 'indeterminate'
      const l = new BackgroundLedger(fakeProbes({ bash: () => verdict }))
      l.ingestJsonl(SURFACE, [toolResultEntry(BASH_ACK)])
      assertEq(await l.reconcile(SURFACE, 0), false)          // clock starts
      verdict = 'running'
      assertEq(await l.reconcile(SURFACE, 4 * 60_000), false) // clock cleared
      verdict = 'indeterminate'
      assertEq(await l.reconcile(SURFACE, 5 * 60_000), false) // clock restarts here
      assertEq(await l.reconcile(SURFACE, 9 * 60_000), false) // only 4 min of no evidence
      assertEq(l.outstandingCount(SURFACE), 1)
      assertEq(await l.reconcile(SURFACE, 11 * 60_000), true) // 6 min → drained
    },
  },
  {
    name: 'a launch whose surface has no probe context is indeterminate, not immortal',
    run: async () => {
      // No setContext() call, so an agent launch has no transcript dir to read.
      const l = new BackgroundLedger(fakeProbes({ agent: 'finished' }))
      l.registerAgent(SURFACE, 'ad808093cf264cd2d')
      assertEq(await l.reconcile(SURFACE, 0), false)
      assertEq(await l.reconcile(SURFACE, 6 * 60_000), true)
    },
  },
  {
    name: 'activeSurfaces lists only surfaces with outstanding launches',
    run: () => {
      const l = new BackgroundLedger(fakeProbes())
      l.registerAgent(pid('a'), 'x1')
      l.registerAgent(pid('b'), 'x2')
      l.completeAgent(pid('b'), 'x2')
      assertEq(JSON.stringify(l.activeSurfaces()), JSON.stringify(['a']))
    },
  },

  // ── agentTranscriptVerdict: what a subagent's own transcript proves ──
  {
    name: 'transcript ending in end_turn is finished',
    run: () => {
      assertEq(agentTranscriptVerdict([assistantLine('tool_use'), assistantLine('end_turn')].join('\n')), 'finished')
    },
  },
  {
    name: 'transcript ending mid-tool is running, not finished',
    run: () => {
      assertEq(agentTranscriptVerdict([assistantLine('end_turn'), assistantLine('tool_use'), toolResultLine('ok')].join('\n')), 'running')
    },
  },
  {
    name: 'user interruption after the last assistant entry is terminal',
    run: () => {
      // The live case that pinned a surface yellow: no SubagentStop hook fires,
      // and stop_reason stays 'tool_use' forever.
      const tail = [assistantLine('tool_use'), toolResultLine('cat output…'), interruptLine()].join('\n')
      assertEq(agentTranscriptVerdict(tail), 'finished')
    },
  },
  {
    name: 'the "for tool use" interruption wording is also terminal',
    run: () => {
      const tail = [assistantLine('tool_use'), interruptLine('[Request interrupted by user for tool use]')].join('\n')
      assertEq(agentTranscriptVerdict(tail), 'finished')
    },
  },
  {
    name: 'an interruption BEFORE the last assistant entry does not end it',
    run: () => {
      // The agent was interrupted, then resumed and is now mid-tool.
      const tail = [interruptLine(), assistantLine('tool_use')].join('\n')
      assertEq(agentTranscriptVerdict(tail), 'running')
    },
  },
  {
    name: 'an interruption quoted inside a tool_result is ignored',
    run: () => {
      // A subagent that greps transcripts would otherwise fake its own death.
      const tail = [assistantLine('tool_use'), toolResultLine('[Request interrupted by user]')].join('\n')
      assertEq(agentTranscriptVerdict(tail), 'running')
    },
  },
  {
    name: 'a window with no assistant entry is indeterminate, not running',
    run: () => {
      // Why the tail read grows: this is the answer that means "look further
      // back", and treating it as 'running' is what stuck the indicator.
      assertEq(agentTranscriptVerdict([toolResultLine('a'), toolResultLine('b')].join('\n')), 'indeterminate')
    },
  },
  {
    name: 'a truncated leading line (mid-entry tail read) is skipped, not fatal',
    run: () => {
      const tail = ['{"type":"assist', assistantLine('end_turn')].join('\n')
      assertEq(agentTranscriptVerdict(tail), 'finished')
    },
  },
  {
    name: 'an empty window is indeterminate',
    run: () => {
      assertEq(agentTranscriptVerdict(''), 'indeterminate')
    },
  },
]

function assertEq(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

describe('BackgroundLedger', () => {
  for (const c of cases) {
    it(c.name, async () => { await c.run() })
  }
})
