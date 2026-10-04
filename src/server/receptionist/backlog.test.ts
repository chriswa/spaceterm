import { describe, expect, it } from 'vitest'
import {
  ageWords, Backlog, jevBacklogJudge, jevBacklogRequest, MAX_BACKLOG, MAX_ITEM_CHARS, pickNext, readBacklogProbabilities,
  type BacklogContext,
} from './backlog'

function memoryStore(initial?: string) {
  const store = { json: initial, load: () => store.json, save: (json: string) => { store.json = json } }
  return store
}

const ctx: BacklogContext = {
  conversation: 'THE USER SAYS: Yeah.\nYOU: {"say":[{"from":"control","text":"Sending those answers to Dean."}]}',
  items: [
    { text: '{Leon:fern-hippo} finished the go-quiet follow-up; the user talked over its report.', age: '4 minutes ago' },
    { text: '{Dean:stormy-glove} asked two questions the user has not answered.', age: '1 minute ago' },
  ],
}

describe('Backlog', () => {
  it('keeps items oldest first, and takes one out by position', () => {
    const backlog = new Backlog({ store: memoryStore() })
    backlog.add('first', 1)
    backlog.add('second', 2)
    backlog.add('third', 3)
    expect(backlog.take(1)).toEqual({ text: 'second', addedAt: 2 })
    expect(backlog.all().map(item => item.text)).toEqual(['first', 'third'])
    expect(backlog.take(5)).toBeUndefined()
  })

  it('survives a restart', () => {
    const store = memoryStore()
    new Backlog({ store }).add('Leon finished', 7)
    expect(new Backlog({ store }).all()).toEqual([{ text: 'Leon finished', addedAt: 7 }])
  })

  it('starts empty from a corrupt file', () => {
    expect(new Backlog({ store: memoryStore('{not json') }).size).toBe(0)
  })

  it('drops the oldest past the cap, and says which', () => {
    const backlog = new Backlog({ store: memoryStore() })
    for (let i = 0; i < MAX_BACKLOG; i++) expect(backlog.add(`item ${i}`, i)).toEqual([])
    expect(backlog.add('one too many', MAX_BACKLOG)).toEqual([{ text: 'item 0', addedAt: 0 }])
    expect(backlog.size).toBe(MAX_BACKLOG)
  })

  it('trims an overlong item', () => {
    const backlog = new Backlog({ store: memoryStore() })
    backlog.add('x'.repeat(MAX_ITEM_CHARS * 2))
    expect(backlog.all()[0].text).toHaveLength(MAX_ITEM_CHARS)
  })

  it('puts taken items back where they were by age', () => {
    const backlog = new Backlog({ store: memoryStore() })
    backlog.add('old', 1)
    backlog.add('middle', 2)
    backlog.add('new', 3)
    const taken = backlog.take(1)!
    backlog.restore([taken])
    expect(backlog.all().map(item => item.text)).toEqual(['old', 'middle', 'new'])
  })
})

describe('pickNext', () => {
  it('takes the item Jev rates highest', async () => {
    expect(await pickNext(ctx, async () => [0.2, 0.8])).toEqual({ index: 1, reason: 'judged', probabilities: [0.2, 0.8] })
  })

  it('does not ask about a single item', async () => {
    let asked = false
    const one = { ...ctx, items: ctx.items.slice(0, 1) }
    expect(await pickNext(one, async () => { asked = true; return [1] })).toEqual({ index: 0, reason: 'only-one' })
    expect(asked).toBe(false)
  })

  it('falls back to the oldest when Jev cannot say', async () => {
    expect(await pickNext(ctx, async () => { throw new Error('jev exited with code 1') }))
      .toEqual({ index: 0, reason: 'judge-failed', error: 'jev exited with code 1' })
  })
})

describe('Jev request', () => {
  it('offers each item, with its age, as one option, against the recent conversation', () => {
    const request = jevBacklogRequest(ctx)
    expect(request.state).toEqual({ recent_conversation: ctx.conversation })
    const next = (request.questions as Record<string, { type: string; criteria: Record<string, string> }>).next
    expect(next.type).toBe('choice')
    expect(Object.keys(next.criteria)).toEqual(['b0', 'b1'])
    expect(next.criteria.b0).toContain('Leon')
    expect(next.criteria.b0).toContain('4 minutes ago')
  })

  it('reads the probabilities back in item order, an item Jev left out counting as zero', () => {
    expect(readBacklogProbabilities({ answers: { next: { probabilities: { b1: 0.7, b0: 0.3 } } } }, 3)).toEqual([0.3, 0.7, 0])
    expect(readBacklogProbabilities({ answers: {} }, 2)).toBeUndefined()
  })

  it('judges through the jev runner, and fails without an answer', async () => {
    const judge = jevBacklogJudge(async () => ({ answers: { next: { probabilities: { b0: 0.1, b1: 0.9 } } } }))
    expect(await judge(ctx)).toEqual([0.1, 0.9])
    await expect(jevBacklogJudge(async () => ({}))(ctx)).rejects.toThrow('no probabilities')
  })
})

describe('ageWords', () => {
  it('says how long ago in round units', () => {
    expect(ageWords(10_000)).toBe('just now')
    expect(ageWords(60_000)).toBe('1 minute ago')
    expect(ageWords(3 * 3_600_000)).toBe('3 hours ago')
    expect(ageWords(2 * 86_400_000)).toBe('2 days ago')
  })
})
