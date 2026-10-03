import { describe, it, expect } from 'vitest'
import type { NodeData, TerminalNodeData } from '../../../../shared/state'
import { asNodeId, asPtySessionId, ROOT_NODE_ID, type NodeId } from '../../../../shared/ids'
import { restartableAgentSurfaces, rollingRestart, type RollingRestartDeps } from './rolling-restart'

function terminal(id: string, overrides: Partial<Record<string, unknown>> = {}): TerminalNodeData {
  return {
    type: 'terminal', id: asNodeId(id), parentId: ROOT_NODE_ID,
    x: 0, y: 0, zIndex: 1, sessionId: asPtySessionId(id), cols: 80, rows: 24, alive: true,
    claudeState: 'stopped', claudeStatusUnread: false, claudeStatusAsleep: false,
    sortOrder: 0, terminalSessions: [], claudeSessionHistory: [],
    shellTitleHistory: [], archivedChildren: [], ...overrides
  } as unknown as TerminalNodeData
}

function byId(...nodes: NodeData[]): Record<string, NodeData> {
  return Object.fromEntries(nodes.map((n) => [n.id, n]))
}

/** Records restarts and waits in one log, so their interleaving is asserted too. */
function recordingDeps(failIds: string[] = []): { deps: RollingRestartDeps; log: string[] } {
  const log: string[] = []
  return {
    log,
    deps: {
      restart: async (nodeId: NodeId, args: string) => {
        log.push(`restart ${nodeId} [${args}]`)
        if (failIds.includes(nodeId)) throw new Error('boom')
      },
      wait: async () => { log.push('wait') },
    },
  }
}

describe('restartableAgentSurfaces', () => {
  it('takes live agent surfaces and leaves shells and remnants alone', () => {
    const nodes = byId(
      terminal('claude', { agentType: 'claude' }),
      terminal('legacy', { claudeSessionHistory: [{ claudeSessionId: 'x' }] }),
      terminal('shell'),
      terminal('dead', { agentType: 'codex', alive: false }),
    )
    expect(restartableAgentSurfaces(nodes).map((n) => n.id).sort()).toEqual(['claude', 'legacy'])
  })
})

describe('rollingRestart', () => {
  it('restarts one at a time, staggered, keeping each surface’s CLI args', async () => {
    const { deps, log } = recordingDeps()
    const result = await rollingRestart(
      [terminal('a', { extraCliArgs: '--model opus' }), terminal('b')],
      undefined,
      deps,
    )
    expect(log).toEqual(['restart a [--model opus]', 'wait', 'restart b []'])
    expect(result).toEqual({ restarted: 2, failed: 0 })
  })

  it('carries on past a failure and counts it', async () => {
    const { deps, log } = recordingDeps(['a'])
    const progress: string[] = []
    const result = await rollingRestart(
      [terminal('a'), terminal('b')],
      (done, total) => progress.push(`${done}/${total}`),
      deps,
    )
    expect(log.filter((l) => l.startsWith('restart'))).toHaveLength(2)
    expect(progress).toEqual(['1/2', '2/2'])
    expect(result).toEqual({ restarted: 1, failed: 1 })
  })
})
