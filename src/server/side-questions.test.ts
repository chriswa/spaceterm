import { describe, expect, it } from 'vitest'
import { LISTENING_WINDOW_MS, readForkResult, SideQuestions, type SideQuestionsDeps } from './side-questions'

/** Timers fired by hand. */
function fakeTimers() {
  const timers = new Set<{ fn: () => void; ms: number }>()
  const deps: SideQuestionsDeps = {
    setTimer(fn, ms) {
      const timer = { fn, ms }
      timers.add(timer)
      return () => { timers.delete(timer) }
    },
  }
  const fire = (ms: number) => {
    for (const timer of [...timers]) if (timer.ms === ms) { timers.delete(timer); timer.fn() }
  }
  return { deps, fire, count: () => timers.size }
}

const answered = { isAnswered: true, text: 'MARIGOLD', usage: { cache_read_input_tokens: 38291, input_tokens: 38 } }

describe('SideQuestions', () => {
  it('refuses a surface whose plugin is not polling', async () => {
    const broker = new SideQuestions(fakeTimers().deps)
    expect(await broker.ask('s1', 'what?', 1_000)).toEqual({ ok: false, reason: 'not-listening' })
  })

  it('hands a question to a parked poll and resolves with its answer', async () => {
    const broker = new SideQuestions(fakeTimers().deps)
    const poll = broker.poll('s1', 1_000)
    const asked = broker.ask('s1', 'code word?', 1_500)
    const question = await poll
    expect(question?.prompt).toBe('code word?')
    broker.answer(question!.id, answered, 1800)
    expect(await asked).toEqual({ ok: true, text: 'MARIGOLD', usage: answered.usage, ms: 1800 })
  })

  it('queues a question asked between polls for the next one', async () => {
    const t = fakeTimers()
    const broker = new SideQuestions(t.deps)
    const first = broker.poll('s1', 1_000)
    t.fire(15_000)
    expect(await first).toBeUndefined()
    const asked = broker.ask('s1', 'still there?', 2_000)
    const question = await broker.poll('s1', 3_000)
    expect(question?.prompt).toBe('still there?')
    broker.answer(question!.id, answered)
    expect((await asked).ok).toBe(true)
  })

  it('stops counting a surface as listening once it has not polled for a while', () => {
    const broker = new SideQuestions(fakeTimers().deps)
    void broker.poll('s1', 1_000)
    expect(broker.isListening('s1', 1_000 + LISTENING_WINDOW_MS)).toBe(true)
    expect(broker.isListening('s1', 1_001 + LISTENING_WINDOW_MS)).toBe(false)
  })

  it('times a question out, and takes it back from the queue', async () => {
    const t = fakeTimers()
    const broker = new SideQuestions(t.deps)
    const poll = broker.poll('s1', 1_000)
    t.fire(15_000)
    await poll
    const asked = broker.ask('s1', 'anyone?', 2_000, 5_000)
    t.fire(5_000)
    expect(await asked).toEqual({ ok: false, reason: 'timeout' })
    // The plugin's next poll does not get a question nobody is waiting for.
    const next = broker.poll('s1', 3_000)
    t.fire(15_000)
    expect(await next).toBeUndefined()
  })

  it('lets a newer poll replace one whose connection went away', async () => {
    const broker = new SideQuestions(fakeTimers().deps)
    const stale = broker.poll('s1', 1_000)
    const fresh = broker.poll('s1', 2_000)
    expect(await stale).toBeUndefined()
    const asked = broker.ask('s1', 'q', 2_500)
    expect((await fresh)?.prompt).toBe('q')
    void asked
  })

  it('ignores an answer to a question it does not know', () => {
    const broker = new SideQuestions(fakeTimers().deps)
    expect(() => broker.answer('nope', answered)).not.toThrow()
  })
})

describe('readForkResult', () => {
  it('passes through the fork reasons, and rejects anything else', () => {
    expect(readForkResult({ isAnswered: false, reason: 'nothing-to-fork' })).toEqual({ ok: false, reason: 'nothing-to-fork' })
    expect(readForkResult({ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded_error' }))
      .toEqual({ ok: false, reason: 'api-error', detail: '529 overloaded_error' })
    expect(readForkResult({ isAnswered: false, reason: 'made-up' })).toEqual({ ok: false, reason: 'invalid-reply' })
    expect(readForkResult('nonsense')).toEqual({ ok: false, reason: 'invalid-reply' })
  })
})
