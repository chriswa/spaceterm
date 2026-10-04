import { describe, expect, it } from 'vitest'
import {
  CONVERSATION_WORDS, decideInterruption, INTERRUPT_THRESHOLD, jevInterruptionRequest, jevJudge, lastWords, MIN_WORDS_LEFT,
  readInterruptProbability, splitAtOffset, type InterruptionContext,
} from './self-interruption'

const REPLY = 'Kevin is still working on the solver. He expects to need another hour, and then he will run the full test suite before he commits anything.'

const ctx = (offset: number): InterruptionContext => ({
  speech: splitAtOffset(REPLY, offset),
  conversation: 'THE USER SAYS: what is Kevin doing?',
  events: ['{Kevin} is now stopped, waiting for the user. It last said: The solver is done and the tests pass.'],
})

describe('splitAtOffset', () => {
  it('takes the word just before the offset as the one being said, as the speech reports it', () => {
    const at = REPLY.indexOf('working') + 'working'.length
    expect(splitAtOffset(REPLY, at)).toEqual({
      said: 'Kevin is still',
      currentWord: 'working',
      remaining: 'on the solver. He expects to need another hour, and then he will run the full test suite before he commits anything.',
    })
  })

  it('has no current word before the first one, and nothing left at the end', () => {
    expect(splitAtOffset(REPLY, 0)).toEqual({ said: '', currentWord: '', remaining: REPLY })
    expect(splitAtOffset(REPLY, REPLY.length + 5).remaining).toBe('')
  })
})

describe('decideInterruption', () => {
  it('does not ask when a dozen words or fewer are left', async () => {
    let asked = false
    const tail = REPLY.split(' ').slice(-MIN_WORDS_LEFT).join(' ')
    const verdict = await decideInterruption(ctx(REPLY.length - tail.length), async () => { asked = true; return 1 })
    expect(verdict).toMatchObject({ interrupt: false, reason: 'few-words' })
    expect(asked).toBe(false)
  })

  it('cuts in at or above the threshold, and not below it', async () => {
    const early = ctx(REPLY.indexOf('working') + 7)
    expect(await decideInterruption(early, async () => INTERRUPT_THRESHOLD)).toMatchObject({ interrupt: true, reason: 'judged' })
    expect(await decideInterruption(early, async () => INTERRUPT_THRESHOLD - 0.01)).toMatchObject({ interrupt: false, reason: 'judged' })
  })

  it('keeps talking when Jev cannot be asked', async () => {
    const verdict = await decideInterruption(ctx(10), async () => { throw new Error('jev exited with code 1') })
    expect(verdict).toMatchObject({ interrupt: false, reason: 'judge-failed', error: 'jev exited with code 1' })
  })
})

describe('the Jev request', () => {
  it('shows the reply split at the voice, the conversation and the news, and asks one yes/no question', () => {
    const request = jevInterruptionRequest(ctx(REPLY.indexOf('working') + 7))
    expect(request.state).toMatchObject({
      reply_already_said: 'Kevin is still', word_being_said_now: 'working',
      news_just_arrived: expect.stringContaining('The solver is done'),
    })
    expect(request.questions).toMatchObject({ interrupt: { type: 'noul' } })
  })

  it('reads the probability from the answer, and refuses anything else', async () => {
    expect(readInterruptProbability({ answers: { interrupt: { type: 'noul', noul: 0.82 } } })).toBe(0.82)
    expect(readInterruptProbability({ answers: {} })).toBeUndefined()
    await expect(jevJudge(async () => ({ answers: {} }))(ctx(10))).rejects.toThrow(/no probability/)
    expect(await jevJudge(async () => ({ answers: { interrupt: { noul: 0.3 } } }))(ctx(10))).toBe(0.3)
  })
})

describe('lastWords', () => {
  it('keeps whole words from the end', () => {
    const text = Array.from({ length: CONVERSATION_WORDS + 50 }, (_, i) => `w${i}`).join(' ')
    const kept = lastWords(text, CONVERSATION_WORDS).split(' ')
    expect(kept).toHaveLength(CONVERSATION_WORDS)
    expect(kept[0]).toBe('w50')
  })
})
