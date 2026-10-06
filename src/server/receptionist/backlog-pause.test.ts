import { describe, expect, it } from 'vitest'
import { decidePause, jevPauseRequest, readPauseJudgement, READY_THRESHOLD } from './backlog-pause'

describe('backlog pause', () => {
  it('asks Jev both questions about the conversation', () => {
    const request = jevPauseRequest('YOU: Sent to Kevin.')
    expect(request.state).toEqual({ recent_conversation: 'YOU: Sent to Kevin.' })
    expect(Object.keys(request.questions)).toEqual(['now', 'after_pause'])
  })

  it('reads both probabilities, and nothing when either is missing or out of range', () => {
    expect(readPauseJudgement({ answers: { now: { noul: 0.2 }, after_pause: { noul: 0.7 } } })).toEqual({ now: 0.2, afterPause: 0.7 })
    expect(readPauseJudgement({ answers: { now: { noul: 0.2 } } })).toBeUndefined()
    expect(readPauseJudgement({ answers: { now: { noul: 2 }, after_pause: { noul: 0.7 } } })).toBeUndefined()
    expect(readPauseJudgement(undefined)).toBeUndefined()
  })

  it('brings an item up now, after the pause, or not yet', async () => {
    const at = (now: number, afterPause: number) => decidePause('', async () => ({ now, afterPause }))
    expect((await at(READY_THRESHOLD, 0)).when).toBe('now')
    expect((await at(0.1, READY_THRESHOLD)).when).toBe('after-pause')
    expect((await at(0.1, 0.1)).when).toBe('not-yet')
  })

  it('brings nothing up when Jev cannot say', async () => {
    const verdict = await decidePause('', async () => { throw new Error('jev is down') })
    expect(verdict).toEqual({ when: 'not-yet', reason: 'judge-failed', error: 'jev is down' })
  })
})
