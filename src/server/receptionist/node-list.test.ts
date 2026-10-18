import { describe, expect, it } from 'vitest'
import { asNodeId, asPtySessionId, ROOT_NODE_ID, type NodeId } from '../../shared/ids'
import type { DirectoryNodeData, MarkdownNodeData, MetaGroupNodeData, NodeData, TerminalNodeData, TitleNodeData } from '../../shared/state'
import { Handles, NODE_PREFIX } from './handles'
import { NODE_LIST_CHARS, NOTE_CHARS, pathWords, renderNodeList, type NodeListContext } from './node-list'

const base = (id: string, parentId: string) => ({ id: asNodeId(id), parentId: asNodeId(parentId), x: 0, y: 0, zIndex: 1, archivedChildren: [] })
const directory = (id: string, parentId: string, cwd: string): DirectoryNodeData => ({ ...base(id, parentId), type: 'directory', cwd })
const title = (id: string, parentId: string, text: string): TitleNodeData => ({ ...base(id, parentId), type: 'title', text })
const markdown = (id: string, parentId: string, content: string): MarkdownNodeData =>
  ({ ...base(id, parentId), type: 'markdown', width: 400, height: 300, content })
const terminal = (id: string, parentId: string, name: string): TerminalNodeData => ({
  ...base(id, parentId), type: 'terminal', name, alive: true, sessionId: asPtySessionId(id), cols: 80, rows: 24,
  claudeState: 'stopped', claudeStatusUnread: false, claudeStatusAsleep: false, sortOrder: 0, terminalSessions: [],
  claudeSessionHistory: [], shellTitleHistory: [],
} as unknown as TerminalNodeData)

/**
 * Two titles both called Fleet, under two directories, and a title that shares
 * its name with a directory: the canvas the path exists for.
 */
const NODES: NodeData[] = [
  title('toolcraft', ROOT_NODE_ID, 'toolcraft'),
  directory('spaceterm', 'toolcraft', '~/spaceterm'),
  title('fleet-a', 'spaceterm', 'Fleet'),
  terminal('kevin', 'fleet-a', 'water sim'),
  directory('goxcraft', ROOT_NODE_ID, '~/goxcraft'),
  title('fleet-b', 'goxcraft', 'Fleet'),
  title('goxcraft-title', 'goxcraft', 'goxcraft'),
  markdown('note', 'goxcraft', `${'a'.repeat(300)}\nsecond line secret`),
  terminal('shell', ROOT_NODE_ID, 'zsh'),
  title('misc', ROOT_NODE_ID, 'misc'),
  { ...base('meta', 'goxcraft'), type: 'meta-group', hostId: asNodeId('goxcraft'), groupKind: 'meta', label: 'Agent docs', sourcePath: '/x', ephemeral: true } as MetaGroupNodeData,
]

function context(nodes: readonly NodeData[] = NODES): NodeListContext {
  const handles = new Handles(nodes.map(node => node.id), NODE_PREFIX)
  return {
    rootCwd: '~',
    handleOf: (nodeId: NodeId) => handles.of(nodeId)!,
    agentTokenOf: (nodeId: NodeId) => nodeId === 'kevin' ? '{Kevin:amber-otter}' : undefined,
  }
}

const lineOf = (text: string, handle: string) => text.split('\n').find(line => line.startsWith(`[${handle}]`))!

describe('renderNodeList', () => {
  it('tells apart nodes that share a name by what they sit under', () => {
    const ctx = context()
    const { text } = renderNodeList(NODES, 'directories and titles', ctx)
    const fleetA = lineOf(text, ctx.handleOf(asNodeId('fleet-a')))
    const fleetB = lineOf(text, ctx.handleOf(asNodeId('fleet-b')))
    expect(fleetA).toContain('title "Fleet"')
    expect(fleetB).toContain('title "Fleet"')
    expect(fleetA).not.toBe(fleetB)
    expect(fleetA).toContain('title "toolcraft" > directory ~/spaceterm')
    expect(fleetB).toContain('directory ~/goxcraft')
    expect(lineOf(text, ctx.handleOf(asNodeId('goxcraft-title')))).toContain('under: directory ~/goxcraft')
  })

  it('says which directory an agent started under a title runs in, the root default at the top', () => {
    const ctx = context()
    const { text } = renderNodeList(NODES, 'titles', ctx)
    expect(lineOf(text, ctx.handleOf(asNodeId('fleet-b')))).toContain('agents started here run in ~/goxcraft')
    expect(lineOf(text, ctx.handleOf(asNodeId('misc')))).toContain('at the top level')
    expect(lineOf(text, ctx.handleOf(asNodeId('misc')))).toContain('agents started here run in ~')
  })

  it('shows what each filter asks for, and never generated nodes', () => {
    const ctx = context()
    const types = (show: Parameters<typeof renderNodeList>[1]) => renderNodeList(NODES, show, ctx).matched
    expect(types('directories')).toBe(2)
    expect(types('titles')).toBe(5)
    expect(types('directories and titles')).toBe(7)
    expect(types('everything')).toBe(10)
    expect(renderNodeList(NODES, 'everything', ctx).text).not.toContain('Agent docs')
  })

  it('names an agent by its token, and a node under it by the agent', () => {
    const nodes = [...NODES, title('under-kevin', 'kevin', 'later')]
    const ctx = context(nodes)
    const { text } = renderNodeList(nodes, 'everything', ctx)
    expect(text).toContain('{Kevin:amber-otter} agent "water sim" | under: title "toolcraft" > directory ~/spaceterm > title "Fleet"')
    expect(lineOf(text, ctx.handleOf(asNodeId('under-kevin')))).toContain('> {Kevin:amber-otter} agent "water sim"')
    expect(text).toContain('terminal "zsh"')
  })

  it('shows a note only by the start of its first line', () => {
    const { text } = renderNodeList(NODES, 'everything', context())
    const note = text.split('\n').find(line => line.includes('note "'))!
    const shown = note.match(/note "([^"]*)"/)![1]
    expect(shown.length).toBeLessThanOrEqual(NOTE_CHARS)
    expect(shown.endsWith('…')).toBe(true)
    expect(text).not.toContain('second line secret')
  })

  it('gives a node the same handle whatever the filter', () => {
    const ctx = context()
    const handle = ctx.handleOf(asNodeId('fleet-b'))
    expect(lineOf(renderNodeList(NODES, 'titles', ctx).text, handle)).toBeDefined()
    expect(lineOf(renderNodeList(NODES, 'everything', ctx).text, handle)).toBeDefined()
  })

  it('counts what a canvas too big for one list leaves out, and says so', () => {
    const many = Array.from({ length: 400 }, (_, i) => title(`t${i}`, ROOT_NODE_ID, `A title long enough to fill the list ${i}`))
    const list = renderNodeList(many, 'titles', context(many))
    expect(list.text.length).toBeLessThan(NODE_LIST_CHARS + 200)
    expect(list.omitted).toBeGreaterThan(0)
    expect(list.text).toContain(`…and ${list.omitted} more`)
  })

  it('survives a parent cycle and a dangling parent', () => {
    const odd = [title('a', 'b', 'A'), title('b', 'a', 'B'), title('orphan', 'gone', 'Orphan')]
    const ctx = context(odd)
    const { text } = renderNodeList(odd, 'titles', ctx)
    expect(lineOf(text, ctx.handleOf(asNodeId('orphan')))).toContain('at the top level')
    expect(pathWords(asNodeId('a'), new Map(odd.map(node => [node.id, node])), ctx)).toBe('title "B"')
  })
})
