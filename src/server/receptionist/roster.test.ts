import { describe, expect, it } from 'vitest'
import { asNodeId } from '../../shared/ids'
import type { TranscriptMessage } from '../summary-chat'
import { ago, readAgent, renderRoster, type RosterAgent } from './roster'

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
  it('shows name, directory, state and the last exchange', () => {
    const a = agent('11111111-0000-4000-8000-000000000000')
    const text = renderRoster([a], () => 'Kevin', () => transcript, H)
    expect(text).toContain(`[${H(a.nodeId)}] Kevin: water sim`)
    expect(text).toContain('directory: fluids')
    expect(text).toContain('state: stopped')
    expect(text).toContain('last asked: Make the water simulation')
    expect(text).toContain('last said: The pressure solver')
  })

  it('marks an agent with no name yet', () => {
    const text = renderRoster([agent('22222222-0000-4000-8000-000000000000')], () => undefined, () => [], H)
    expect(text).toContain('(no name yet)')
  })

  it('says which agents cannot take side questions until they restart', () => {
    const old = agent('33333333-0000-4000-8000-000000000000', { takesSideQuestions: false })
    const fresh = agent('44444444-0000-4000-8000-000000000000', { takesSideQuestions: true })
    const text = renderRoster([old, fresh], () => undefined, () => [], H)
    expect(text.match(/ask_agent: unavailable/g)).toHaveLength(1)
    expect(text.split(`[${H(fresh.nodeId)}]`)[1]).not.toContain('ask_agent: unavailable')
  })

  it('says so when nothing is running', () => {
    expect(renderRoster([], () => undefined, () => [], H)).toMatch(/No agents/)
  })
})

describe('renderRoster: what is worth checking', () => {
  const NOW = Date.parse('2026-10-03T12:00:00Z')
  const min = 60_000

  it('puts unread agents first, then the most recently active', () => {
    const quiet = agent('aaaaaaaa-0000-4000-8000-000000000000', { title: 'quiet', lastActivityAt: NOW - 120 * min })
    const busy = agent('bbbbbbbb-0000-4000-8000-000000000000', { title: 'busy', lastActivityAt: NOW - 1 * min })
    const news = agent('cccccccc-0000-4000-8000-000000000000', { title: 'news', unread: true, lastActivityAt: NOW - 300 * min })
    const text = renderRoster([quiet, busy, news], () => undefined, () => [], H, NOW)
    const order = ['news', 'busy', 'quiet'].map(title => text.indexOf(`: ${title}`))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(text).toContain('UNREAD')
  })

  it('says how long ago things happened and how long the cache has left', () => {
    const a = agent('dddddddd-0000-4000-8000-000000000000', {
      stateSince: NOW - 12 * min, lastActivityAt: NOW - 3 * min,
      cacheWarmUntil: NOW + 41 * min, cacheWarmTokens: 120_000, startedAt: NOW - 125 * min,
    })
    const text = renderRoster([a], () => 'Kevin', () => [], H, NOW)
    expect(text).toContain('state: stopped, waiting for the user, for 12 minutes')
    expect(text).toContain('last active: 3 minutes ago')
    expect(text).toContain('cache: warm for 41 minutes more (120k tokens)')
    expect(text).toContain('started: 2 hours 5 minutes ago')
    expect(text).not.toContain('UNREAD')
  })

  it('says when a cache has gone cold', () => {
    const a = agent('eeeeeeee-0000-4000-8000-000000000000', { cacheWarmUntil: NOW - 5 * min })
    expect(renderRoster([a], () => undefined, () => [], H, NOW)).toContain('cache: cold for 5 minutes')
  })
})

describe('renderRoster: last asked', () => {
  it('skips what Claude Code injects as user turns', () => {
    const a = agent('ffffffff-0000-4000-8000-000000000000')
    const text = renderRoster([a], () => undefined, () => [
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
})
