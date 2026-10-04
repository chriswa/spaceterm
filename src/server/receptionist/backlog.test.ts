import { describe, expect, it } from 'vitest'
import { asNodeId } from '../../shared/ids'
import {
  ageWords, Backlog, cacheNote, COLD_SOON_MS, RELEVANT_THRESHOLD, jevBacklogJudge, jevBacklogRequest, MAX_BACKLOG, MAX_ITEM_CHARS, pickNext, readBacklogJudgement,
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
  it('keeps items oldest first, and takes any out by position', () => {
    const backlog = new Backlog({ store: memoryStore() })
    backlog.add('first', 1)
    backlog.add('second', 2)
    backlog.add('third', 3)
    backlog.add('fourth', 4)
    expect(backlog.take([3, 1])).toEqual([{ text: 'second', addedAt: 2 }, { text: 'fourth', addedAt: 4 }])
    expect(backlog.all().map(item => item.text)).toEqual(['first', 'third'])
    expect(backlog.take([5])).toEqual([])
  })

  it('survives a restart', () => {
    const store = memoryStore()
    new Backlog({ store }).add('Leon finished', 7)
    expect(new Backlog({ store }).all()).toEqual([{ text: 'Leon finished', addedAt: 7 }])
  })

  it('keeps the agents an item is about, across a restart', () => {
    const store = memoryStore()
    const kevin = asNodeId('kevin-surface')
    new Backlog({ store }).add('{Kevin:amber-otter} finished', 7, [kevin])
    expect(new Backlog({ store }).all()).toEqual([{ text: '{Kevin:amber-otter} finished', addedAt: 7, agents: [kevin] }])
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
    backlog.restore(backlog.take([1]))
    expect(backlog.all().map(item => item.text)).toEqual(['old', 'middle', 'new'])
  })
})

describe('pickNext', () => {
  it('takes the item Jev rates highest', async () => {
    expect(await pickNext(ctx, async () => [0.2, 0.8])).toEqual({ indices: [1], reason: 'judged', probabilities: [0.2, 0.8] })
  })

  it('does not ask about a single item', async () => {
    let asked = false
    const one = { ...ctx, items: ctx.items.slice(0, 1) }
    expect(await pickNext(one, async () => { asked = true; return [1] })).toEqual({ indices: [0], reason: 'only-one' })
    expect(asked).toBe(false)
  })

  it('falls back to the oldest when Jev cannot say', async () => {
    expect(await pickNext(ctx, async () => { throw new Error('jev exited with code 1') }))
      .toEqual({ indices: [0], reason: 'judge-failed', error: 'jev exited with code 1' })
  })

  it('takes every item about what Control asks for, even the only one', async () => {
    const looking = { ...ctx, about: 'the go-quiet work' }
    expect(await pickNext(looking, async () => [0.9, RELEVANT_THRESHOLD])).toMatchObject({ indices: [0, 1], reason: 'judged' })
    expect(await pickNext({ ...looking, items: ctx.items.slice(1) }, async () => [0.8])).toMatchObject({ indices: [0] })
  })

  it('takes nothing when no item is about it, or Jev cannot say', async () => {
    const looking = { ...ctx, about: 'the release notes' }
    expect(await pickNext(looking, async () => [0.2, 0.1])).toMatchObject({ indices: [], reason: 'judged' })
    expect(await pickNext(looking, async () => { throw new Error('timeout') }))
      .toEqual({ indices: [], reason: 'judge-failed', error: 'timeout' })
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

  it('tells Jev what waiting on an item costs, and to weigh it', () => {
    const cache = "WARNING: {Leon:fern-hippo}'s prompt cache goes cold in 4 minutes, and continuing it after that costs much more"
    const request = jevBacklogRequest({ ...ctx, items: [{ ...ctx.items[0], cache }, ctx.items[1]] })
    const next = (request.questions as Record<string, { instructions: string; criteria: Record<string, string> }>).next
    expect(next.criteria.b0).toContain(`4 minutes ago; ${cache}`)
    expect(next.criteria.b1).not.toContain('cache')
    expect(next.instructions).toContain('goes cold soonest')
  })

  it('asks of each item, separately, whether it is about what Control is looking for', () => {
    const request = jevBacklogRequest({ ...ctx, about: "Dean's questions" })
    expect(request.state).toEqual({ recent_conversation: ctx.conversation, looking_for: "Dean's questions" })
    const questions = request.questions as Record<string, { type: string; instructions: string }>
    expect(Object.keys(questions)).toEqual(['b0', 'b1'])
    expect(questions.b1.type).toBe('noul')
    expect(questions.b1.instructions).toContain('{Dean:stormy-glove} asked two questions')
  })

  it('reads the probabilities back in item order, an item Jev left out counting as zero', () => {
    const three = { ...ctx, items: [...ctx.items, ctx.items[0]] }
    expect(readBacklogJudgement({ answers: { next: { probabilities: { b1: 0.6, b0: 0.3 } } } }, three)).toEqual([0.3, 0.6, 0])
    expect(readBacklogJudgement({ answers: { b0: { noul: 0.9 }, b2: { noul: 0.2 } } }, { ...three, about: 'x' })).toEqual([0.9, 0, 0.2])
    expect(readBacklogJudgement({ answers: {} }, ctx)).toBeUndefined()
    expect(readBacklogJudgement({ answers: {} }, { ...ctx, about: 'x' })).toBeUndefined()
  })

  it('judges through the jev runner, and fails without an answer', async () => {
    const judge = jevBacklogJudge(async () => ({ answers: { next: { probabilities: { b0: 0.1, b1: 0.9 } } } }))
    expect(await judge(ctx)).toEqual([0.1, 0.9])
    await expect(jevBacklogJudge(async () => ({}))(ctx)).rejects.toThrow('no probabilities')
  })
})

describe('cacheNote', () => {
  const agent = '{Kevin:amber-otter}'

  it('warns when the cache goes cold soon', () => {
    expect(cacheNote(agent, 4 * 60_000, 0)).toMatch(/^WARNING: .*goes cold in 4 minutes.*costs much more/)
    expect(cacheNote(agent, COLD_SOON_MS, 0)).toMatch(/^WARNING/)
  })

  it('says how long a cache stays warm when it is not about to go cold', () => {
    expect(cacheNote(agent, 45 * 60_000, 0)).toBe(`${agent}'s prompt cache stays warm for 45 minutes more`)
  })

  it('says nothing once the cache is cold, since waiting longer costs nothing more', () => {
    expect(cacheNote(agent, 0, 1)).toBeUndefined()
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
