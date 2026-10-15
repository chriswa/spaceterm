import { describe, expect, it } from 'vitest'
import { decidePause, jevPauseRequest, pauseDialogue, readPauseJudgement, READY_THRESHOLD } from './backlog-pause'

describe('backlog pause', () => {
  it('asks Jev both questions about the conversation', () => {
    const request = jevPauseRequest('RECEPTIONIST: Sent to Kevin.')
    expect(request.state).toEqual({ recent_conversation: 'RECEPTIONIST: Sent to Kevin.' })
    expect(Object.keys(request.questions)).toEqual(['now', 'after_pause'])
  })

  it('reads both probabilities, and nothing when either is missing or out of range', () => {
    expect(readPauseJudgement({ answers: { now: { noul: 0.2 }, after_pause: { noul: 0.7 } } })).toEqual({ now: 0.2, afterPause: 0.7 })
    expect(readPauseJudgement({ answers: { now: { noul: 0.2 } } })).toBeUndefined()
    expect(readPauseJudgement({ answers: { now: { noul: 2 }, after_pause: { noul: 0.7 } } })).toBeUndefined()
    expect(readPauseJudgement(undefined)).toBeUndefined()
  })

  it('brings an item up now, after the pause, or after a long quiet when the user is mid-topic', async () => {
    const at = (now: number, afterPause: number) => decidePause('', async () => ({ now, afterPause }))
    expect((await at(READY_THRESHOLD, 0)).when).toBe('now')
    expect((await at(0.1, READY_THRESHOLD)).when).toBe('after-pause')
    expect((await at(0.1, 0.1)).when).toBe('mid-topic')
  })

  it('brings nothing up when Jev cannot say', async () => {
    const verdict = await decidePause('', async () => { throw new Error('jev is down') })
    expect(verdict).toEqual({ when: 'not-yet', reason: 'judge-failed', error: 'jev is down' })
  })

  it('shows Jev the dialogue: the user\'s words and what Control said, without events or silent replies', () => {
    const dialogue = pauseDialogue([
      { role: 'user', content: 'EVENTS:\n{Dean:stormy-iguana} is now stopped. It last said: Things you might want to change...\n\nTHE USER SAYS: start an agent on the badge\n\nBACKLOG: 4 items set aside for later.' },
      { role: 'assistant', content: 'STARTED {Grant:velvet-river} in ~/spaceterm: Add a badge.' },
      { role: 'assistant', content: '{"say":[{"from":"control","text":"Started Grant."}]}' },
      { role: 'user', content: 'EVENTS:\n{Ruth:upper-hammer} is now stopped.\n\nThe user has not said anything. Decide whether the events are worth speaking up about.' },
      { role: 'assistant', content: '{"say":[]}' },
    ])
    expect(dialogue).toBe([
      'USER: start an agent on the badge',
      'RECEPTIONIST: STARTED {Grant:velvet-river} in ~/spaceterm: Add a badge.',
      'RECEPTIONIST: Started Grant.',
    ].join('\n'))
  })

  it('keeps the latest words when the dialogue is long, cutting the oldest message short', () => {
    const dialogue = pauseDialogue([
      { role: 'user', content: 'THE USER SAYS: one two three four five' },
      { role: 'assistant', content: '{"say":[{"from":"control","text":"six seven"}]}' },
    ], 4)
    expect(dialogue).toBe('USER: … four five\nRECEPTIONIST: six seven')
  })
})
