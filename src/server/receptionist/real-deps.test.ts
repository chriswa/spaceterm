import { describe, expect, it } from 'vitest'
import { recentMessages, searchConversation } from './real-deps'

const record = [
  { timestamp: '2026-10-02T09:00:00Z', role: 'user', content: 'Tell Kevin the bananas are ripe.' },
  { timestamp: '2026-10-02T09:00:01Z', role: 'assistant', content: '{"say":[{"from":"control","text":"Sent to Kevin."}]}' },
  { timestamp: '2026-10-03T10:00:00Z', role: 'user', content: 'What about the BANANAS now?' },
].map(entry => JSON.stringify(entry)).join('\n') + '\n'

describe('searchConversation', () => {
  it('finds every mention, newest first, with when and who', () => {
    const found = searchConversation(record, 'bananas')
    expect(found.indexOf('2026-10-03')).toBeLessThan(found.indexOf('2026-10-02'))
    expect(found).toContain('USER: Tell Kevin the bananas are ripe.')
  })

  it('says so when nothing matches, and survives a torn last line', () => {
    expect(searchConversation(`${record}{"timestamp":`, 'kiwis')).toMatch(/Nothing in the conversation record/)
  })
})

describe('recentMessages', () => {
  it('takes the last messages, oldest first, skipping a line cut off by reading from the middle', () => {
    const raw = [
      'mestamp":"x","role":"user","content":"cut off"}',
      '{"timestamp":"a","role":"user","content":"THE USER SAYS: one"}',
      '{"timestamp":"b","role":"assistant","content":"two"}',
      '{"timestamp":"c","role":"user","content":"THE USER SAYS: three"}',
      '',
    ].join('\n')
    expect(recentMessages(raw, 2)).toEqual([
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'THE USER SAYS: three' },
    ])
    expect(recentMessages(raw, 10)).toHaveLength(3)
  })
})
