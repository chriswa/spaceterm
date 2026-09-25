import { describe, it, expect } from 'vitest'
import {
  ARCHIVED_CANDIDATE_LIMIT,
  TITLE_PASS_THRESHOLD,
  collectAgentSurfaces,
  searchAgentSurfaces,
  type AgentSearchCandidate,
  type AgentSearchDeps,
  type JevRequest,
} from './agent-search'
import type { ArchivedNode, NodeData, TerminalNodeData } from '../shared/state'
import { asNodeId, ROOT_NODE_ID } from '../shared/ids'

function terminal(id: string, overrides: Partial<TerminalNodeData> = {}): TerminalNodeData {
  return {
    id: asNodeId(id),
    type: 'terminal',
    parentId: ROOT_NODE_ID,
    alive: true,
    sessionId: id,
    x: 0, y: 0, zIndex: 1, cols: 80, rows: 24,
    claudeState: 'stopped',
    claudeStatusUnread: false,
    claudeStatusAsleep: false,
    sortOrder: 0,
    terminalSessions: [],
    claudeSessionHistory: [{ claudeSessionId: `sess-${id}`, reason: 'startup', timestamp: '' }],
    shellTitleHistory: [],
    archivedChildren: [],
    ...overrides,
  } as unknown as TerminalNodeData
}

const shell = (id: string) => terminal(id, { claudeSessionHistory: [] })

function archivedAt(minute: number, data: NodeData, descendants: ArchivedNode['descendants'] = []): ArchivedNode {
  return { archivedAt: `2026-09-25T10:${String(minute).padStart(2, '0')}:00.000Z`, data, descendants }
}

const byId = (...nodes: NodeData[]) => Object.fromEntries(nodes.map((n) => [n.id, n]))
const idsOf = (surfaces: Array<{ data: NodeData }>) => surfaces.map((s) => s.data.id)

describe('collectAgentSurfaces', () => {
  it('lists live agent surfaces and skips plain shells', () => {
    const surfaces = collectAgentSurfaces(byId(terminal('agent'), shell('shell')), [])
    expect(surfaces).toEqual([{ data: expect.objectContaining({ id: 'agent' }), archived: false }])
  })

  it('finds archived agent surfaces inside archived subtrees and under live nodes', () => {
    const host = terminal('host', { archivedChildren: [archivedAt(1, terminal('under-host'))] })
    const subtree = archivedAt(2, shell('parent'), [{ data: terminal('swept-in'), descendants: [] }])
    const surfaces = collectAgentSurfaces(byId(host), [subtree])
    expect(surfaces.filter((s) => s.archived).map((s) => s.data.id).sort()).toEqual(['swept-in', 'under-host'])
  })

  it('keeps only the most recently archived, newest first', () => {
    const archives = Array.from({ length: ARCHIVED_CANDIDATE_LIMIT + 5 }, (_, i) => archivedAt(i, terminal(`a${i}`)))
    const archived = collectAgentSurfaces({}, archives)
    expect(archived).toHaveLength(ARCHIVED_CANDIDATE_LIMIT)
    expect(idsOf(archived)[0]).toBe(`a${ARCHIVED_CANDIDATE_LIMIT + 4}`)
  })
})

function candidate(id: string, transcriptPath?: string): AgentSearchCandidate {
  return { nodeId: asNodeId(id), title: `title ${id}`, archived: false, transcriptPath }
}

/** A Jev that answers each pass with the next probabilities, keyed by candidate index. */
function fakeJev(passes: Array<{ probabilities: Record<string, number>; cost: number | null }>) {
  const requests: JevRequest[] = []
  const deps: AgentSearchDeps = {
    runJev: async (request) => {
      const pass = passes[requests.length]
      requests.push(request)
      return { answers: { target: { probabilities: pass.probabilities } }, _cost_estimate: pass.cost }
    },
    transcriptTail: (path) => `tail of ${path}`,
  }
  return { deps, requests }
}

const optionsOf = (request: JevRequest) =>
  (request.questions.target as { criteria: Record<string, Record<string, string>> }).criteria

describe('searchAgentSurfaces', () => {
  it('stops after the titles pass when one surface is confident enough', async () => {
    const { deps, requests } = fakeJev([{ probabilities: { s0: 0.1, s1: TITLE_PASS_THRESHOLD, none: 0.15 }, cost: 0.001 }])
    const outcome = await searchAgentSurfaces('find b', [candidate('a', '/t/a'), candidate('b')], deps)
    expect(requests).toHaveLength(1)
    expect(optionsOf(requests[0]).s0).not.toHaveProperty('recent_transcript')
    expect(outcome).toEqual({
      pass: 'titles',
      hits: [{ nodeId: 'b', probability: TITLE_PASS_THRESHOLD }, { nodeId: 'a', probability: 0.1 }],
      noneProbability: 0.15,
      costUsd: 0.001,
    })
  })

  it('asks again with transcripts when the titles pass is unsure, and sums the cost', async () => {
    const { deps, requests } = fakeJev([
      { probabilities: { s0: 0.5, s1: 0.5 }, cost: 0.001 },
      { probabilities: { s0: 0.9, s1: 0.1 }, cost: 0.002 },
    ])
    const outcome = await searchAgentSurfaces('find a', [candidate('a', '/t/a'), candidate('b')], deps)
    expect(requests).toHaveLength(2)
    expect(optionsOf(requests[1]).s0.recent_transcript).toBe('tail of /t/a')
    expect(optionsOf(requests[1]).s1.recent_transcript).toBe('(no transcript available)')
    expect(outcome.pass).toBe('transcripts')
    expect(outcome.hits[0]).toEqual({ nodeId: 'a', probability: 0.9 })
    expect(outcome.costUsd).toBeCloseTo(0.003)
  })

  it('reports an unknown total cost if either pass could not be priced', async () => {
    const { deps } = fakeJev([{ probabilities: { s0: 0.2 }, cost: null }, { probabilities: { s0: 0.3 }, cost: 0.002 }])
    expect((await searchAgentSurfaces('q', [candidate('a')], deps)).costUsd).toBeNull()
  })

  it('does not call Jev with no candidates', async () => {
    const { deps, requests } = fakeJev([])
    expect((await searchAgentSurfaces('q', [], deps)).hits).toEqual([])
    expect(requests).toHaveLength(0)
  })
})
