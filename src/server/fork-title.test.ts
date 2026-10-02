import { describe, expect, it } from 'vitest'
import type { NodeData, TerminalNodeData } from '../shared/state'
import type { NodeId } from '../shared/ids'
import { FORK_LABEL, ForkTitler, forkName, isNamingPrompt, parseForkTitleReply, surfaceTitle } from './fork-title'

const NODE = 'node-1' as NodeId

function terminal(patch: Partial<TerminalNodeData> = {}): TerminalNodeData {
  return { id: NODE, type: 'terminal', name: null, shellTitleHistory: [], ...patch } as unknown as TerminalNodeData
}

describe('forkName', () => {
  it('is the bare label without a title', () => {
    expect(forkName(undefined)).toBe(FORK_LABEL)
    expect(forkName(null)).toBe(FORK_LABEL)
    expect(forkName('  ')).toBe(FORK_LABEL)
  })

  it('prefixes a title', () => {
    expect(forkName('Fix login redirect')).toBe('[fork] Fix login redirect')
  })

  it('does not stack prefixes when forking a fork', () => {
    expect(forkName('[fork] Fix login redirect')).toBe('[fork] Fix login redirect')
    expect(forkName('[Fork] [fork] x')).toBe('[fork] x')
  })
})

describe('surfaceTitle', () => {
  it('prefers the custom name, without its fork label', () => {
    expect(surfaceTitle(terminal({ name: '[fork] API server', shellTitleHistory: ['shell'] }))).toBe('API server')
  })

  it('falls back to the newest shell title', () => {
    expect(surfaceTitle(terminal({ shellTitleHistory: ['newest', 'older'] }))).toBe('newest')
  })

  it('is null for a surface with neither', () => {
    expect(surfaceTitle(terminal({ name: FORK_LABEL }))).toBeNull()
  })
})

describe('isNamingPrompt', () => {
  it('accepts typed text', () => {
    expect(isNamingPrompt('now try it with websockets')).toBe(true)
  })

  it('waits past slash commands, task notifications and blanks', () => {
    expect(isNamingPrompt('/clear')).toBe(false)
    expect(isNamingPrompt('<task-notification>done</task-notification>')).toBe(false)
    expect(isNamingPrompt('   ')).toBe(false)
    expect(isNamingPrompt(undefined)).toBe(false)
  })
})

describe('parseForkTitleReply', () => {
  it('takes the first line, without quotes or trailing punctuation', () => {
    expect(parseForkTitleReply('\n"Websocket transport for API."\nextra')).toBe('Websocket transport for API')
  })

  it('drops a fork label the model added anyway', () => {
    expect(parseForkTitleReply('[fork] Websocket transport')).toBe('Websocket transport')
  })

  it('caps the word count', () => {
    expect(parseForkTitleReply('one two three four five six seven eight')?.split(' ')).toHaveLength(6)
  })

  it('is null for an empty reply', () => {
    expect(parseForkTitleReply(' \n ')).toBeNull()
  })
})

function harness(initial: TerminalNodeData, reply: () => Promise<string> = async () => 'Websocket transport') {
  let node: NodeData = initial
  const asked: string[] = []
  const logs: string[] = []
  const titler = new ForkTitler({
    ask: async (prompt) => { asked.push(prompt); return reply() },
    getNode: () => node,
    clearPending: () => { node = { ...node, pendingForkTitle: null } as NodeData },
    rename: (_id, name) => { node = { ...node, name } as NodeData },
    log: (m) => logs.push(m),
  })
  return {
    titler, asked, logs,
    get node() { return node as TerminalNodeData },
    setName(name: string) { node = { ...node, name } as NodeData },
  }
}

const pendingFork = (): TerminalNodeData => terminal({ name: FORK_LABEL, pendingForkTitle: { parentTitle: 'API server' } })

describe('ForkTitler', () => {
  it('names a fork from its parent title and first prompt', async () => {
    const h = harness(pendingFork())
    await h.titler.onPrompt(NODE, 'switch the transport to websockets')
    expect(h.node.name).toBe('[fork] Websocket transport')
    expect(h.node.pendingForkTitle).toBeNull()
    expect(h.asked[0]).toContain('API server')
    expect(h.asked[0]).toContain('switch the transport to websockets')
  })

  it('names only once', async () => {
    const h = harness(pendingFork())
    await h.titler.onPrompt(NODE, 'first')
    await h.titler.onPrompt(NODE, 'second')
    expect(h.asked).toHaveLength(1)
  })

  it('waits for a prompt the user wrote', async () => {
    const h = harness(pendingFork())
    await h.titler.onPrompt(NODE, '/model haiku')
    expect(h.asked).toHaveLength(0)
    expect(h.node.pendingForkTitle).not.toBeNull()
  })

  it('leaves surfaces that are not pending forks alone', async () => {
    const h = harness(terminal({ name: FORK_LABEL }))
    await h.titler.onPrompt(NODE, 'hello')
    expect(h.asked).toHaveLength(0)
  })

  it('keeps a name the user set before the first prompt', async () => {
    const h = harness(pendingFork())
    h.setName('my name')
    await h.titler.onPrompt(NODE, 'hello')
    expect(h.asked).toHaveLength(0)
    expect(h.node.name).toBe('my name')
  })

  it('keeps a name the user set while Haiku was answering', async () => {
    let release!: (s: string) => void
    const h = harness(pendingFork(), () => new Promise(r => { release = r }))
    const done = h.titler.onPrompt(NODE, 'hello')
    await Promise.resolve()
    h.setName('my name')
    release('Websocket transport')
    await done
    expect(h.node.name).toBe('my name')
  })

  it('stays [fork] and logs when the call fails', async () => {
    const h = harness(pendingFork(), async () => { throw new Error('daemon down') })
    await h.titler.onPrompt(NODE, 'hello')
    expect(h.node.name).toBe(FORK_LABEL)
    expect(h.logs.join()).toContain('daemon down')
  })
})
