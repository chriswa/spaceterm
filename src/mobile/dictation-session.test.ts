import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useDictationSession } from './dictation-session'
import type { Dictation } from './dictation'

/** What the session uses of a dictation: sound arriving, finishing, cancelling. */
function fakeDictation(finish: () => Promise<string> = async () => 'hello there') {
  return { audioArrived: Promise.resolve(), finish: vi.fn(finish), cancel: vi.fn(), describe: () => '' } as unknown as Dictation & { cancel: ReturnType<typeof vi.fn> }
}

beforeEach(() => useDictationSession.setState({ mic: { kind: 'idle' }, error: null }))

describe('dictation session', () => {
  it('listens once sound arrives, and hands back what was said when stopped', async () => {
    const session = useDictationSession.getState()
    await session.start(Promise.resolve(fakeDictation()))
    expect(useDictationSession.getState().mic.kind).toBe('listening')
    await expect(useDictationSession.getState().finish()).resolves.toBe('hello there')
    expect(useDictationSession.getState().mic.kind).toBe('idle')
  })

  it('one at a time: a second start while listening is dropped, not stacked', async () => {
    await useDictationSession.getState().start(Promise.resolve(fakeDictation()))
    const extra = fakeDictation()
    await useDictationSession.getState().start(Promise.resolve(extra))
    await Promise.resolve()
    expect(extra.cancel).toHaveBeenCalled()
  })

  it('a failed transcription says why and leaves the microphone free', async () => {
    await useDictationSession.getState().start(Promise.resolve(fakeDictation(async () => { throw new Error('Voice Operator is not running') })))
    await expect(useDictationSession.getState().finish()).resolves.toBeNull()
    expect(useDictationSession.getState()).toMatchObject({ mic: { kind: 'idle' }, error: 'Voice Operator is not running' })
  })

  it('stopping when nothing is listening does nothing', async () => {
    await expect(useDictationSession.getState().finish()).resolves.toBeNull()
  })
})
