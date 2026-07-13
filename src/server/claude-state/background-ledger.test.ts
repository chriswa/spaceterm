import { BackgroundLedger, type LivenessProbes } from './background-ledger'
import type { SessionFileEntry } from '../session-file-watcher'

/**
 * Tests for the background-work ledger — the launch/completion parsing and the
 * liveness-probe reconciliation that decide whether a surface is still
 * "finishing background work" (yellow) after its turn ends.
 *
 * Run with: npm test
 */

const SURFACE = 'surface-1'

// Probes we can steer per-test. Default: everything still running (fail-safe).
function fakeProbes(overrides: Partial<Record<'bash' | 'monitor' | 'agent' | 'workflow', boolean>> = {}): LivenessProbes {
  return {
    bashFinished: async () => overrides.bash ?? false,
    monitorFinished: async () => overrides.monitor ?? false,
    agentFinished: async () => overrides.agent ?? false,
    workflowFinished: async () => overrides.workflow ?? false,
  }
}

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
      const l = new BackgroundLedger(fakeProbes({ bash: false }))
      l.ingestJsonl(SURFACE, [toolResultEntry(BASH_ACK)])
      assertEq(await l.reconcile(SURFACE), false) // still running
      assertEq(l.outstandingCount(SURFACE), 1)

      const l2 = new BackgroundLedger(fakeProbes({ bash: true }))
      l2.ingestJsonl(SURFACE, [toolResultEntry(BASH_ACK)])
      assertEq(await l2.reconcile(SURFACE), true) // finished → pruned
      assertEq(l2.outstandingCount(SURFACE), 0)
    },
  },
  {
    name: 'reconcile never probes a queued launch',
    run: async () => {
      // bash probe says "finished", but the launch is queued → must stay outstanding.
      const l = new BackgroundLedger(fakeProbes({ bash: true }))
      l.ingestJsonl(SURFACE, [toolResultEntry(BASH_ACK)])
      l.ingestJsonl(SURFACE, [{ type: 'queue-operation', operation: 'enqueue', content: DONE('b4g2uhdde') }])
      assertEq(await l.reconcile(SURFACE), false)
      assertEq(l.outstandingCount(SURFACE), 1)
    },
  },
  {
    name: 'activeSurfaces lists only surfaces with outstanding launches',
    run: () => {
      const l = new BackgroundLedger(fakeProbes())
      l.registerAgent('a', 'x1')
      l.registerAgent('b', 'x2')
      l.completeAgent('b', 'x2')
      assertEq(JSON.stringify(l.activeSurfaces()), JSON.stringify(['a']))
    },
  },
]

// ─── runner ─────────────────────────────────────────────────────────────────

let failed = 0
function assertEq(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

async function main(): Promise<void> {
  for (const c of cases) {
    try {
      await c.run()
      console.log(`✓ ${c.name}`)
    } catch (e) {
      failed++
      console.log(`✗ ${c.name}`)
      console.log(`  ${(e as Error).message}`)
    }
  }
  if (failed > 0) {
    console.log(`\n${failed}/${cases.length} cases failed`)
    process.exit(1)
  }
  console.log(`\nall ${cases.length} background-ledger cases passed`)
}

void main()
