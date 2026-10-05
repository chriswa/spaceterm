import { describe, expect, it } from 'vitest'
import { renderTurnBody, splitTurnBody } from './prompt'
import { parseRecordLine, transcriptPage, type RecordFile } from './transcript'

function memoryFile(text: string): RecordFile {
  const bytes = Buffer.from(text, 'utf8')
  return { size: () => bytes.length, read: (start, length) => bytes.subarray(start, start + length) }
}

const line = (role: 'user' | 'assistant', content: string, timestamp = '2026-10-05T08:00:00Z') =>
  JSON.stringify({ timestamp, role, content })

/** `n` exchanges, each a user turn and Control's reply, padded so the record spans many read chunks. */
function longRecord(n: number): string {
  const lines: string[] = []
  for (let i = 0; i < n; i++) {
    lines.push(line('user', renderTurnBody([], `question ${i} ${'é'.repeat(300)}`)))
    lines.push(line('assistant', JSON.stringify({ say: [{ from: 'control', text: `answer ${i}` }] })))
  }
  return lines.join('\n') + '\n'
}

describe('transcriptPage', () => {
  it('pages back from the end to the start, oldest first, each entry exactly once', () => {
    const file = memoryFile(longRecord(400))
    const seen: string[] = []
    let before: number | undefined
    let pages = 0
    for (;;) {
      const page = transcriptPage(file, before, 60)
      pages++
      const texts = page.entries.map(entry => entry.kind === 'user' ? entry.text.split(' ').slice(0, 2).join(' ') : entry.kind === 'reply' ? entry.parts[0].text : entry.kind === 'log' ? entry.text : 'heard')
      seen.unshift(...texts)
      if (!page.more) break
      before = page.entries[0].offset
    }
    expect(pages).toBe(Math.ceil(800 / 60))
    expect(seen).toHaveLength(800)
    expect(seen[0]).toBe('question 0')
    expect(seen.at(-1)).toBe('answer 399')
    expect(new Set(seen).size).toBe(800)
  })

  it('has offsets that point at each line in the record, in bytes', () => {
    const text = longRecord(3)
    const { entries, more } = transcriptPage(memoryFile(text), undefined, 100)
    expect(more).toBe(false)
    const bytes = Buffer.from(text)
    for (const entry of entries) {
      expect(entry.offset === 0 || bytes[entry.offset - 1] === 0x0a).toBe(true)
    }
  })

  it('skips a torn line rather than failing, and an empty record is empty', () => {
    expect(transcriptPage(memoryFile(`${longRecord(1)}{"timestamp":`), undefined, 10).entries).toHaveLength(2)
    expect(transcriptPage(memoryFile(''), undefined, 10)).toEqual({ entries: [], more: false })
  })
})

describe('parseRecordLine', () => {
  it("shows the user's words without what was sent along with them", () => {
    const body = renderTurnBody([{ kind: 'agent-stopped', agent: '{Kevin:amber-otter}', state: 'stopped', lastSaid: 'done' }], 'what is Kevin doing?', undefined, false, 2)
    const entry = parseRecordLine(line('user', body), 0)
    expect(entry).toMatchObject({ kind: 'user', text: 'what is Kevin doing?' })
    expect(entry?.kind === 'user' && entry.context).toMatch(/^EVENTS:/)
    // Agent tokens read as names.
    expect(entry?.kind === 'user' && entry.context).toContain('Kevin')
    expect(entry?.kind === 'user' && entry.context).not.toContain('{Kevin:amber-otter}')
  })

  it('names who spoke each part of a reply', () => {
    const reply = JSON.stringify({ say: [{ from: 'control', text: 'Kevin says:' }, { from: 'Kevin:amber-otter', text: 'All green.' }] })
    expect(parseRecordLine(line('assistant', reply), 7)).toMatchObject({
      offset: 7, kind: 'reply', parts: [{ from: 'Control', text: 'Kevin says:' }, { from: 'Kevin', text: 'All green.' }],
    })
  })

  it('names a speaker the record wrote by handle alone, and a handle in what was said', () => {
    const nameOf = (handle: string) => (handle === 'amber-otter' ? 'Kevin' : undefined)
    const reply = JSON.stringify({ say: [{ from: 'amber-otter', text: 'Ask {amber-otter}.' }, { from: 'keen-barn', text: 'Hm.' }] })
    expect(parseRecordLine(line('assistant', reply), 0, nameOf)).toMatchObject({
      kind: 'reply', parts: [{ from: 'Kevin', text: 'Ask Kevin.' }, { from: 'keen-barn', text: 'Hm.' }],
    })
  })

  it('reads a mark of how much of a reply was heard', () => {
    const mark = JSON.stringify({ timestamp: '2026-10-05T08:00:00Z', heard: { of: 120, parts: [14, 4] } })
    expect(parseRecordLine(mark, 300)).toEqual({ offset: 300, timestamp: '2026-10-05T08:00:00Z', kind: 'heard', of: 120, parts: [14, 4] })
  })

  it('reads an action that never ran, naming its agent', () => {
    const line = JSON.stringify({ timestamp: '2026-10-05T08:00:00Z', notDone: 'SENT TO {amber-otter}: Push it.' })
    expect(parseRecordLine(line, 0, (handle) => (handle === 'amber-otter' ? 'Sally' : undefined)))
      .toMatchObject({ kind: 'log', text: 'SENT TO Sally: Push it.', notDone: true })
  })

  it("shows Control's actions as log lines", () => {
    expect(parseRecordLine(line('assistant', 'UNARCHIVED {Kevin:amber-otter}'), 0)).toMatchObject({ kind: 'log', text: 'UNARCHIVED Kevin' })
    expect(parseRecordLine(line('assistant', 'SENT TO Kevin: ship it'), 0)).toMatchObject({ kind: 'log', text: 'SENT TO Kevin: ship it' })
  })
})

describe('splitTurnBody', () => {
  const heard = 'first line\n\nsecond paragraph'
  it.each([
    ['alone', renderTurnBody([], heard)],
    ['away', renderTurnBody([], heard, 'away')],
    ['with a backlog', renderTurnBody([], heard, undefined, false, 1)],
    ['back from away', renderTurnBody([], heard, { events: [], unheard: true }, true, 3)],
  ])('recovers exactly what the user said: %s', (_, body) => {
    expect(splitTurnBody(body)?.heard).toBe(heard)
  })

  it('finds nothing in a turn the user did not speak in', () => {
    expect(splitTurnBody(renderTurnBody([{ kind: 'agent-ended', agent: 'x', archived: true, lastSaid: '' }], undefined))).toBeUndefined()
  })
})
