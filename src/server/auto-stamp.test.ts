import { describe, it, expect } from 'vitest'
import {
  AutoStamper, autoStampPrompt, autoStampTitle, parseAutoStampReply,
  type AutoStampReply,
} from './auto-stamp'
import { asNodeId } from '../shared/ids'
import type { AutoStamp, NodeData } from '../shared/state'

const NODE = asNodeId('node-1')
const SVG = '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="40"/></svg>'

function reply(description: string, cost = 0.01): AutoStampReply {
  return { text: `<description>${description}</description>\n${SVG}`, costUsd: cost, claudeSessionId: 'claude-1' }
}

function terminal(id: string, title: string): NodeData {
  return { id: asNodeId(id), type: 'terminal', name: null, shellTitleHistory: [title] } as unknown as NodeData
}

function harness(title = 'Fix the parser', extra: NodeData[] = []) {
  const node = terminal(NODE, title)
  const nodes = new Map<string, NodeData>([[NODE, node], ...extra.map((n) => [n.id, n] as const)])
  let enabled = true
  const prompts: string[] = []
  const replies: Array<(r: AutoStampReply | Error) => void> = []
  const timers: Array<{ fn: () => void; cancelled: boolean }> = []
  const stamper = new AutoStamper({
    ask: (prompt) => {
      prompts.push(prompt)
      return new Promise((resolve, reject) => {
        replies.push((r) => (r instanceof Error ? reject(r) : resolve(r)))
      })
    },
    getNode: (id) => nodes.get(id),
    getNodes: () => [...nodes.values()],
    isEnabled: () => enabled,
    setAutoStamp: (id, autoStamp: AutoStamp) => { nodes.get(id)!.autoStamp = autoStamp },
    schedule: (fn) => {
      const timer = { fn, cancelled: false }
      timers.push(timer)
      return () => { timer.cancelled = true }
    },
    log: () => {},
  })
  return {
    node, nodes, stamper, prompts,
    setEnabled(value: boolean) { enabled = value },
    setTitle(t: string) { (node as { shellTitleHistory: string[] }).shellTitleHistory = [t]; stamper.titleMaybeChanged(NODE) },
    /** Fire every live settle timer. */
    settle() { for (const t of timers.splice(0)) if (!t.cancelled) t.fn() },
    async answer(r: AutoStampReply | Error) { replies.shift()!(r); await new Promise((res) => setTimeout(res, 0)) },
  }
}

describe('autoStampTitle', () => {
  it('prefers the name the user typed', () => {
    expect(autoStampTitle({ type: 'terminal', name: 'Mine', shellTitleHistory: ['Auto'] } as unknown as NodeData)).toBe('Mine')
  })

  it('drops the status glyph an agent CLI puts before its title', () => {
    expect(autoStampTitle({ type: 'terminal', name: null, shellTitleHistory: ['✳ Fix the parser'] } as unknown as NodeData)).toBe('Fix the parser')
  })
})

describe('autoStampPrompt', () => {
  it('names the title and asks for a monochrome silhouette', () => {
    const prompt = autoStampPrompt('Fix the parser', [])
    expect(prompt).toContain('<title>Fix the parser</title>')
    expect(prompt).toMatch(/monochrome silhouette/)
    expect(prompt).not.toMatch(/something different/)
  })

  it('shows earlier attempts by description and asks for something different', () => {
    const prompt = autoStampPrompt('Fix the parser', ['A wrench.', 'A bug.'])
    expect(prompt).toContain('- A wrench.\n- A bug.')
    expect(prompt.trimEnd().endsWith('Choose a different object or metaphor from every previous icon.')).toBe(true)
  })
})

describe('parseAutoStampReply', () => {
  it('takes the description and the SVG', () => {
    expect(parseAutoStampReply(`<description>A wrench.</description>\n${SVG}`)).toEqual({ description: 'A wrench.', svg: SVG })
  })

  it('refuses a reply with no SVG', () => {
    expect(parseAutoStampReply('<description>A wrench.</description>')).toEqual({ error: 'reply contained no <svg>' })
  })
})

describe('AutoStamper', () => {
  it('draws a new title once it has settled', async () => {
    const h = harness()
    h.setTitle('Fix the lexer')
    h.setTitle('Fix the parser')
    expect(h.prompts).toHaveLength(0)

    h.settle()
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]).toContain('<title>Fix the parser</title>')
    expect(h.node.autoStamp?.status).toBe('generating')

    await h.answer(reply('A wrench.'))
    expect(h.node.autoStamp).toMatchObject({ status: 'ready', svg: SVG, description: 'A wrench.', title: 'Fix the parser', previousDescriptions: ['A wrench.'] })
  })

  it('leaves a title it has already drawn alone', async () => {
    const h = harness()
    h.stamper.titleMaybeChanged(NODE)
    h.settle()
    await h.answer(reply('A wrench.'))

    h.stamper.titleMaybeChanged(NODE)
    h.settle()
    expect(h.prompts).toHaveLength(1)
  })

  it('regenerates with every earlier description, and adds up the cost', async () => {
    const h = harness()
    h.stamper.titleMaybeChanged(NODE)
    h.settle()
    await h.answer(reply('A wrench.', 0.01))
    h.stamper.regenerate(NODE)
    await h.answer(reply('A bug.', 0.02))
    h.stamper.regenerate(NODE)

    expect(h.prompts[2]).toContain('- A wrench.\n- A bug.')
    expect(h.prompts[2]).toMatch(/No, something different/)
    expect(h.node.autoStamp?.costUsd).toBeCloseTo(0.03)
  })

  it('keeps the old icon on screen while its replacement is drawn', async () => {
    const h = harness()
    h.stamper.regenerate(NODE)
    await h.answer(reply('A wrench.'))
    h.stamper.regenerate(NODE)
    expect(h.node.autoStamp).toMatchObject({ status: 'generating', svg: SVG, description: 'A wrench.' })
  })

  it('starts the list of earlier icons again for a new title', async () => {
    const h = harness()
    h.stamper.regenerate(NODE)
    await h.answer(reply('A wrench.'))
    h.setTitle('Deploy the app')
    h.settle()
    await h.answer(reply('A rocket.'))
    h.stamper.regenerate(NODE)
    expect(h.prompts[2]).toContain('- A rocket.')
    expect(h.prompts[2]).not.toContain('A wrench.')
  })

  it('draws one icon at a time, then catches up with the newest title', async () => {
    const h = harness()
    h.stamper.regenerate(NODE)
    h.stamper.regenerate(NODE)
    expect(h.prompts).toHaveLength(1)

    const terminal = h.node as { shellTitleHistory: string[] }
    terminal.shellTitleHistory = ['Deploy the app']
    h.stamper.regenerate(NODE)
    await h.answer(reply('A wrench.'))
    h.settle()
    expect(h.prompts).toHaveLength(2)
    expect(h.prompts[1]).toContain('<title>Deploy the app</title>')
  })

  it('records why a generation failed, keeping the cost of an unusable reply', async () => {
    const h = harness()
    h.stamper.regenerate(NODE)
    await h.answer(new Error('claude-print-daemon exited 1: daemon returned 502'))
    expect(h.node.autoStamp).toMatchObject({ status: 'failed', error: expect.stringContaining('502') })

    h.stamper.regenerate(NODE)
    await h.answer({ text: 'I cannot draw that.', costUsd: 0.01, claudeSessionId: 'claude-2' })
    expect(h.node.autoStamp).toMatchObject({ status: 'failed', error: 'reply contained no <svg>', costUsd: 0.01 })
  })

  it('draws nothing while generation is turned off', () => {
    const h = harness()
    h.setEnabled(false)
    h.stamper.titleMaybeChanged(NODE)
    h.stamper.regenerate(NODE)
    h.settle()
    expect(h.prompts).toHaveLength(0)
  })

  it('leaves cards that are not surfaces alone', () => {
    const markdown = { id: asNodeId('md-1'), type: 'markdown', name: 'Notes' } as unknown as NodeData
    const h = harness('Fix the parser', [markdown])
    h.stamper.regenerate(markdown.id)
    expect(h.prompts).toHaveLength(0)
  })

  it('draws every surface on a sweep, two at a time', async () => {
    const h = harness('Fix the parser', [terminal('node-2', 'Deploy the app'), terminal('node-3', 'Write the docs')])
    h.stamper.resume()
    h.settle()
    expect(h.prompts).toHaveLength(2)

    await h.answer(reply('A wrench.'))
    expect(h.prompts).toHaveLength(3)
    expect(h.prompts[2]).toContain('<title>Write the docs</title>')
  })

  it('finishes a generation the previous server left running', () => {
    const h = harness()
    h.node.autoStamp = { title: 'Fix the parser', status: 'generating', previousDescriptions: [], costUsd: 0 }
    h.stamper.resume()
    expect(h.prompts).toHaveLength(1)
  })

  it('retries a failed icon on a sweep, but not when the title merely repeats', async () => {
    const h = harness()
    h.stamper.regenerate(NODE)
    await h.answer(new Error('spawn claude-print-daemon ENOENT'))
    expect(h.node.autoStamp?.status).toBe('failed')

    h.setTitle('Fix the parser')
    h.settle()
    expect(h.prompts).toHaveLength(1)

    h.stamper.resume()
    expect(h.prompts).toHaveLength(2)
  })
})
