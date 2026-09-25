import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { AgentSearchModal } from './AgentSearchModal'
import { installFakeBridge, type FakeBridge } from '../testing/fake-bridge'
import { useNodeStore } from '../stores/nodeStore'
import { useAgentSearchStore } from '../stores/agentSearchStore'
import { asNodeId, ROOT_NODE_ID } from '../../../../shared/ids'
import type { NodeData } from '../../../../shared/state'

function terminal(id: string, name: string): NodeData {
  return {
    id: asNodeId(id), type: 'terminal', parentId: ROOT_NODE_ID, name,
    alive: true, sessionId: id, x: 0, y: 0, zIndex: 1, cols: 80, rows: 24,
    agentType: 'claude', claudeState: 'stopped', claudeStatusUnread: false, claudeStatusAsleep: false,
    sortOrder: 0, terminalSessions: [], claudeSessionHistory: [], shellTitleHistory: [], archivedChildren: [],
  } as unknown as NodeData
}

let bridge: FakeBridge
const props = () => ({
  visible: true,
  resolvedPresets: {},
  onDismiss: vi.fn(),
  onNavigateToNode: vi.fn(),
  onReviveNode: vi.fn(),
})

beforeEach(() => {
  bridge = installFakeBridge()
  localStorage.clear()
  useAgentSearchStore.setState({ query: '', status: { kind: 'idle' } })
  useNodeStore.setState({
    nodes: { live: terminal('live', 'Jev wrapper') },
    rootArchivedChildren: [{ archivedAt: '2026-09-25T10:00:00.000Z', data: terminal('gone', 'Old bugbot run') }],
  })
  bridge.responses.agentSearch = {
    ok: true,
    pass: 'transcripts',
    hits: [
      { nodeId: asNodeId('gone'), probability: 0.6 },
      { nodeId: asNodeId('live'), probability: 0.3 },
    ],
    noneProbability: 0.1,
    costUsd: 0.000321,
  }
})

afterEach(cleanup)

async function searchFor(query: string, p = props()) {
  const view = render(<AgentSearchModal {...p} />)
  const input = view.getByPlaceholderText(/agent session/)
  fireEvent.change(input, { target: { value: query } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(view.getByTestId('agent-search-summary').textContent).toContain('$0.000321'))
  return view
}

describe('AgentSearchModal', () => {
  it('does not search while typing, only on Enter', () => {
    const view = render(<AgentSearchModal {...props()} />)
    fireEvent.change(view.getByPlaceholderText(/agent session/), { target: { value: 'jev' } })
    expect(bridge.callsTo('node.agentSearch')).toHaveLength(0)
  })

  it('lists hits most probable first, says which passes ran, and marks archived ones', async () => {
    const view = await searchFor('bugbot')
    expect(bridge.callsTo('node.agentSearch')).toHaveLength(1)
    expect(view.getByTestId('agent-search-summary').textContent).toContain('Titles, then transcripts')

    const cards = [...view.container.querySelectorAll('.agent-search__card')]
    expect(cards.map(c => c.querySelector('.agent-search__percent')?.textContent)).toEqual(['60%', '30%'])
    expect(cards[0].textContent).toContain('Archived')
    expect(cards[1].querySelector('.agent-search__archived-badge')).toBeNull()
  })

  it('restores an archived hit and flies to a live one', async () => {
    const p = props()
    const view = await searchFor('bugbot', p)
    const cards = view.container.querySelectorAll('.agent-search__card')

    fireEvent.click(cards[0])
    expect(p.onReviveNode).toHaveBeenCalledWith(ROOT_NODE_ID, ['gone'], 'gone')

    fireEvent.click(cards[1])
    expect(p.onNavigateToNode).toHaveBeenCalledWith('live')
  })

  it('persists the last search so reopening shows it again', async () => {
    await searchFor('bugbot')
    expect(JSON.parse(localStorage.getItem('agentSearch.last')!)).toMatchObject({ query: 'bugbot', result: { costUsd: 0.000321 } })
  })
})
