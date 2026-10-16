import { describe, expect, it } from 'vitest'
import { asNodeId } from '../../shared/ids'
import { lastAgentProse, parseWholeTranscript, type TranscriptMessage } from '../agent-transcript'
import { ago, capMessage, MESSAGE_CHARS, readAgent, renderAgentDetails, renderRoster, type RosterAgent } from './roster'

const transcript: TranscriptMessage[] = [
  { role: 'user', text: 'Make the water simulation conserve volume.' },
  { role: 'assistant', text: 'The pressure solver now conserves volume; bananas float.' },
]

/** A stand-in handle: what renderRoster prints is the caller's concern. */
const H = (nodeId: string): string => `h-${nodeId.slice(0, 4)}`

const agent = (id: string, extra: Partial<RosterAgent> = {}): RosterAgent => ({
  nodeId: asNodeId(id), title: 'water sim', cwd: '/Users/me/projects/fluids', state: 'stopped',
  transcriptPath: `/t/${id}.jsonl`, ...extra,
})

describe('renderRoster', () => {
  it('shows each agent on one line: name, title and state', () => {
    const a = agent('11111111-0000-4000-8000-000000000000')
    const text = renderRoster([a], () => 'Kevin', H)
    expect(text).toBe(`{Kevin:${H(a.nodeId)}}: water sim | state: stopped, waiting for the user`)
  })

  it('leaves the detail to agent_details', () => {
    const a = agent('11111111-0000-4000-8000-000000000000', { messagingId: 'spaceterm-43', takesSideQuestions: false, startedAt: 1 })
    const text = renderRoster([a], () => 'Kevin', H)
    for (const left of ['directory', 'messaging id', 'started', 'ask_agent', 'last asked', 'last said']) expect(text).not.toContain(left)
  })

  it('marks an agent with no name yet', () => {
    const text = renderRoster([agent('22222222-0000-4000-8000-000000000000')], () => undefined, H)
    expect(text).toContain('(no name yet)')
  })

  it('says so when nothing is running', () => {
    expect(renderRoster([], () => undefined, H)).toMatch(/No agents/)
  })
})

describe('renderRoster: what is worth checking', () => {
  const NOW = Date.parse('2026-10-03T12:00:00Z')
  const min = 60_000

  it('puts unread agents first, then the most recently active', () => {
    const quiet = agent('aaaaaaaa-0000-4000-8000-000000000000', { title: 'quiet', lastActivityAt: NOW - 120 * min })
    const busy = agent('bbbbbbbb-0000-4000-8000-000000000000', { title: 'busy', lastActivityAt: NOW - 1 * min })
    const news = agent('cccccccc-0000-4000-8000-000000000000', { title: 'news', unread: true, lastActivityAt: NOW - 300 * min })
    const text = renderRoster([quiet, busy, news], () => undefined, H, NOW)
    const order = ['news', 'busy', 'quiet'].map(title => text.indexOf(`: ${title}`))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(text.split('\n').filter(line => line.includes('UNREAD'))).toHaveLength(1)
  })

  it('says how long the state has lasted and how long the cache has left', () => {
    const a = agent('dddddddd-0000-4000-8000-000000000000', {
      stateSince: NOW - 12 * min, cacheWarmUntil: NOW + 41 * min, cacheWarmTokens: 120_000,
    })
    const text = renderRoster([a], () => 'Kevin', H, NOW)
    expect(text).toContain('state: stopped, waiting for the user, for 12 minutes')
    expect(text).toContain('cache: warm for 41 minutes more (120k tokens)')
    expect(text).not.toContain('UNREAD')
  })

  it('says when a cache has gone cold', () => {
    const a = agent('eeeeeeee-0000-4000-8000-000000000000', { cacheWarmUntil: NOW - 5 * min })
    expect(renderRoster([a], () => undefined, H, NOW)).toContain('cache: cold for 5 minutes')
  })
})

describe('renderAgentDetails', () => {
  const NOW = Date.parse('2026-10-03T12:00:00Z')
  const min = 60_000

  it('shows the agent in depth, with the start of its last exchange', () => {
    const a = agent('11111111-0000-4000-8000-000000000000', {
      unread: true, stateSince: NOW - 12 * min, lastActivityAt: NOW - 3 * min,
      cacheWarmUntil: NOW + 41 * min, cacheWarmTokens: 120_000, startedAt: NOW - 125 * min, messagingId: 'spaceterm-43',
    })
    const text = renderAgentDetails(a, () => 'Kevin', transcript, H, NOW)
    expect(text).toContain(`{Kevin:${H(a.nodeId)}}: water sim`)
    expect(text).toContain('UNREAD')
    expect(text).toContain('directory: fluids')
    expect(text).toContain('state: stopped, waiting for the user, for 12 minutes')
    expect(text).toContain('last active: 3 minutes ago')
    expect(text).toContain('cache: warm for 41 minutes more (120k tokens)')
    expect(text).toContain('started: 2 hours 5 minutes ago')
    expect(text).toContain('messaging id: spaceterm-43')
    expect(text).toContain('last asked: Make the water simulation')
    expect(text).toContain('last said: The pressure solver')
  })

  it('says when the agent cannot take side questions until it restarts', () => {
    const old = agent('33333333-0000-4000-8000-000000000000', { takesSideQuestions: false })
    const fresh = agent('44444444-0000-4000-8000-000000000000', { takesSideQuestions: true })
    expect(renderAgentDetails(old, () => undefined, [], H)).toContain('ask_agent: unavailable')
    expect(renderAgentDetails(fresh, () => undefined, [], H)).not.toContain('ask_agent: unavailable')
  })

  it('skips what Claude Code injects as user turns when saying what it was last asked', () => {
    const text = renderAgentDetails(agent('ffffffff-0000-4000-8000-000000000000'), () => undefined, [
      { role: 'user', text: 'Make geodes whole.' },
      { role: 'user', text: '<task-notification> <task-id>b7a7</task-id> deploy finished' },
      { role: 'assistant', text: 'The geode fix is live.' },
    ], H)
    expect(text).toContain('last asked: Make geodes whole.')
  })
})

describe('ago', () => {
  it('reads the way it would be said', () => {
    expect(ago(40_000)).toBe('40 seconds')
    expect(ago(60_000)).toBe('1 minute')
    expect(ago(3 * 3_600_000)).toBe('3 hours')
    expect(ago(2 * 86_400_000)).toBe('2 days')
  })
})

describe('readAgent', () => {
  it('returns the conversation, labelled and numbered', () => {
    const text = readAgent(transcript)
    expect(text).toMatch(/^\[1\] USER: Make the water/)
    expect(text).toContain('[2] AGENT: The pressure solver')
    expect(text).toMatch(/this reaches the start of the conversation/)
  })

  it('finds messages for a search, and says when there are none', () => {
    expect(readAgent(transcript, { search: 'Bananas' })).toContain('bananas float')
    expect(readAgent(transcript, { search: 'kiwis' })).toMatch(/No passage mentions "kiwis"/)
  })

  // What Control was given before: a list missing its first entry, each long message cut after a line or two.
  const report = Array.from({ length: 8 }, (_, i) => `${i + 1}. Item ${i + 1}: ${'detail '.repeat(40).trim()}`).join('\n')
  const long: TranscriptMessage[] = [
    { role: 'user', text: 'Give me the report in batches.' },
    ...Array.from({ length: 6 }, (_, i): TranscriptMessage => ({ role: 'assistant', text: `Batch ${i + 1}\n${report}` })),
  ]

  it('keeps every message whole, line breaks and all', () => {
    const text = readAgent(long)
    expect(text).toContain(`[7] AGENT: Batch 6\n${report}`)
    expect(text).not.toContain('…')
  })

  it('pages back from the number a page ends on, until the start', () => {
    const seen: string[] = []
    let before: number | undefined
    for (let pages = 0; pages < 10; pages++) {
      const text = readAgent(long, { before })
      seen.unshift(text)
      const more = text.match(/"before": (\d+)/)
      if (!more) break
      before = Number(more[1])
    }
    expect(seen.length).toBeGreaterThan(1)
    const all = seen.join('\n')
    for (let i = 1; i <= 6; i++) expect(all).toContain(`AGENT: Batch ${i}\n${report}`)
    expect(all.match(/\[\d+\]/g)).toEqual(['[1]', '[2]', '[3]', '[4]', '[5]', '[6]', '[7]'])
    expect(seen[0]).toMatch(/this reaches the start of the conversation/)
  })

  it('finds a message by every word searched for, not any one of them', () => {
    const text = readAgent(long, { search: 'Batch 3' })
    expect(text).toMatch(/^\[4\] AGENT: Batch 3\n1\. Item 1/)
    expect(text).not.toContain('Batch 2')
  })

  it('pages a search the same way, and says when nothing earlier matches', () => {
    expect(readAgent(long, { search: 'batch', before: 1 })).toBe('Nothing matching before message 1.')
    const text = readAgent(long, { search: 'batch', before: 3 })
    expect(text).toContain('[1] USER: Give me the report in batches.\n\n[2] AGENT: Batch 1')
    expect(text).toMatch(/No earlier matching messages\.\)$/)
  })

  it('cuts only a message past MESSAGE_CHARS, and says how much is missing', () => {
    expect(capMessage(report)).toBe(report)
    const dump = 'x'.repeat(MESSAGE_CHARS + 123)
    expect(capMessage(dump)).toMatch(/\n\[… 123 more characters of this message not shown\]$/)
  })

  // An agent that says what it will do, then commits and self-terminates, writes nothing after its last tool call.
  const selfTerminated = parseWholeTranscript([
    { type: 'user', message: { content: 'Edit the prompt, then commit, push and self-terminate.' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'The edit is in; committing and ending now.' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git commit && git push' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'self_terminate', input: {} }] } },
  ].map(entry => JSON.stringify(entry)).join('\n'))

  it('leaves tool calls out of a plain read, and keeps them searchable', () => {
    expect(readAgent(selfTerminated)).toBe('[1] USER: Edit the prompt, then commit, push and self-terminate.\n\n[2] AGENT: The edit is in; committing and ending now.\n\n(No earlier messages: this reaches the start of the conversation.)')
    expect(readAgent(selfTerminated, { search: 'git push' })).toContain('git commit && git push')
  })

  it('reports the last words an agent wrote before its final tool calls', () => {
    expect(lastAgentProse(selfTerminated)).toBe('The edit is in; committing and ending now.')
    const text = renderAgentDetails(agent('a'), () => 'Wendy', selfTerminated, H)
    expect(text).toContain('last said: The edit is in; committing and ending now.')
  })
})
