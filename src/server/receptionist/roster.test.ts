import { describe, expect, it } from 'vitest'
import { asNodeId } from '../../shared/ids'
import type { TranscriptMessage } from '../summary-chat'
import { handleFor, readAgent, renderRoster, type RosterAgent } from './roster'

const transcript: TranscriptMessage[] = [
  { role: 'user', text: 'Make the water simulation conserve volume.' },
  { role: 'assistant', text: 'The pressure solver now conserves volume; bananas float.' },
]

const agent = (id: string, extra: Partial<RosterAgent> = {}): RosterAgent => ({
  nodeId: asNodeId(id), title: 'water sim', cwd: '/Users/me/projects/fluids', state: 'stopped',
  transcriptPath: `/t/${id}.jsonl`, ...extra,
})

describe('handleFor', () => {
  it('is stable and short', () => {
    const id = asNodeId('3f9a2c71-0000-4000-8000-000000000000')
    expect(handleFor(id)).toBe(handleFor(id))
    expect(handleFor(id)).toMatch(/^a[0-9a-z]{6}$/)
  })
})

describe('renderRoster', () => {
  it('shows name, directory, state and the last exchange', () => {
    const a = agent('11111111-0000-4000-8000-000000000000')
    const text = renderRoster([a], () => 'Kevin', () => transcript)
    expect(text).toContain(`[${handleFor(a.nodeId)}] Kevin: water sim`)
    expect(text).toContain('directory: fluids')
    expect(text).toContain('state: stopped')
    expect(text).toContain('last asked: Make the water simulation')
    expect(text).toContain('last said: The pressure solver')
  })

  it('marks an agent with no name yet', () => {
    const text = renderRoster([agent('22222222-0000-4000-8000-000000000000')], () => undefined, () => [])
    expect(text).toContain('(no name yet)')
  })

  it('says so when nothing is running', () => {
    expect(renderRoster([], () => undefined, () => [])).toMatch(/No agents/)
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
