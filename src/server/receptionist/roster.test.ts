import { describe, expect, it } from 'vitest'
import { asNodeId } from '../../shared/ids'
import { lastAgentProse, parseWholeTranscript, type TranscriptMessage } from '../agent-transcript'
import { ago, readAgent, renderAgentDetails, renderRoster, type RosterAgent } from './roster'

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
  it('returns the conversation, labelled', () => {
    const text = readAgent(transcript)
    expect(text).toMatch(/^USER: Make the water/)
    expect(text).toContain('AGENT: The pressure solver')
  })

  it('finds passages for a search, and says when there are none', () => {
    expect(readAgent(transcript, 'Bananas')).toContain('bananas float')
    expect(readAgent(transcript, 'kiwis')).toMatch(/No recent passage/)
  })

  // An agent that says what it will do, then commits and self-terminates, writes nothing after its last tool call.
  const selfTerminated = parseWholeTranscript([
    { type: 'user', message: { content: 'Edit the prompt, then commit, push and self-terminate.' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'The edit is in; committing and ending now.' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git commit && git push' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'self_terminate', input: {} }] } },
  ].map(entry => JSON.stringify(entry)).join('\n'))

  it('leaves tool calls out of a plain read, and keeps them searchable', () => {
    expect(readAgent(selfTerminated)).toBe('USER: Edit the prompt, then commit, push and self-terminate.\n\nAGENT: The edit is in; committing and ending now.')
    expect(readAgent(selfTerminated, 'git push')).toContain('git commit && git push')
  })

  it('reports the last words an agent wrote before its final tool calls', () => {
    expect(lastAgentProse(selfTerminated)).toBe('The edit is in; committing and ending now.')
    const text = renderAgentDetails(agent('a'), () => 'Wendy', selfTerminated, H)
    expect(text).toContain('last said: The edit is in; committing and ending now.')
  })
})
