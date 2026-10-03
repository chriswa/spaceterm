import { describe, expect, it } from 'vitest'
import { asNodeId, asPtySessionId, ROOT_NODE_ID } from '../../shared/ids'
import type { MarkdownNodeData, NodeData, TerminalNodeData, TitleNodeData } from '../../shared/state'
import { nodesNearView, whereWords } from './nearby'

const base = { parentId: ROOT_NODE_ID, zIndex: 1, archivedChildren: [] }

const terminal = (id: string, x: number, y: number, fields: Partial<TerminalNodeData> = {}): TerminalNodeData => ({
  ...base, id: asNodeId(id), x, y, type: 'terminal', alive: true, sessionId: asPtySessionId(id), cols: 80, rows: 24,
  claudeState: 'stopped', claudeStatusUnread: false, claudeStatusAsleep: false, sortOrder: 0, terminalSessions: [],
  claudeSessionHistory: [], shellTitleHistory: [], ...fields,
} as TerminalNodeData)
const markdown = (id: string, x: number, y: number, content: string): MarkdownNodeData =>
  ({ ...base, id: asNodeId(id), x, y, type: 'markdown', width: 400, height: 300, content } as MarkdownNodeData)
const title = (id: string, x: number, y: number, text: string): TitleNodeData =>
  ({ ...base, id: asNodeId(id), x, y, type: 'title', text } as TitleNodeData)

/** A 1000×600 screen centred on (cx, cy). */
const view = (cx: number, cy: number) => ({ x: cx - 500, y: cy - 300, width: 1000, height: 600 })

describe('nodesNearView', () => {
  const nodes: NodeData[] = [
    terminal('agent', 0, 0, { name: 'Water simulation' }),
    markdown('note', 1200, 0, '# Design notes\nmore'),
    title('far', 20_000, 0, 'Archive area'),
  ]

  it('puts the card the middle of the screen is inside first, at distance zero', () => {
    const [first] = nodesNearView(nodes, view(10, 10))
    expect(first).toMatchObject({ nodeId: 'agent', type: 'terminal', label: 'Water simulation', distance: 0, inView: true })
  })

  it('measures to the card edge, orders by distance, and labels every kind of node', () => {
    const near = nodesNearView(nodes, view(1000, 0))
    expect(near.map(node => node.nodeId)).toEqual(['note', 'agent', 'far'])
    expect(near[0].label).toBe('Design notes')
    expect(near[2]).toMatchObject({ label: 'Archive area', inView: false })
  })

  it('says where each one is in words', () => {
    const v = view(10, 10)
    const [agent, , far] = nodesNearView(nodes, v)
    expect(whereWords(agent, v)).toBe('under the middle of the screen')
    expect(whereWords(far, v)).toMatch(/^off screen, about \d+ screens away$/)
  })

  it('reports no more than it is asked for', () => {
    expect(nodesNearView(nodes, view(0, 0), 2)).toHaveLength(2)
  })
})
