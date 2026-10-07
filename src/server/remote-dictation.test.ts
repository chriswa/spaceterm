import { describe, it, expect } from 'vitest'
import { RemoteDictation, WORDS_FOR_CONTROL_LIMIT_MS } from './remote-dictation'
import type { SpeechResponse } from './voice-operator'

/** Voice Operator as a script: what it answers, and a log of what it was asked. */
function fakeVoice(overrides: Partial<Record<'start' | 'audio' | 'finish', SpeechResponse>> = {}) {
  const calls: string[] = []
  const voice = {
    calls,
    async startTranscription(rate: number) {
      calls.push(`start ${rate}`)
      return 'start' in overrides ? overrides.start : { status: 201, body: { id: 't1' } }
    },
    async sendTranscriptionAudio(id: string, pcm: Uint8Array) {
      calls.push(`audio ${id} ${pcm.length}`)
      return 'audio' in overrides ? overrides.audio : { status: 204, body: undefined }
    },
    async finishTranscription(id: string) {
      calls.push(`finish ${id}`)
      return 'finish' in overrides ? overrides.finish : { status: 200, body: { text: 'hello there' } }
    },
    async cancelTranscription(id: string) {
      calls.push(`cancel ${id}`)
      return { status: 204, body: undefined }
    }
  }
  return voice
}

describe('RemoteDictation', () => {
  it('relays a whole dictation in order and returns the text', async () => {
    const voice = fakeVoice()
    const d = new RemoteDictation(voice)
    const started = await d.start('phone', 16000)
    expect(started).toEqual({ ok: true, value: 't1' })
    d.audio('phone', 't1', new Uint8Array(4))
    d.audio('phone', 't1', new Uint8Array(6))
    await expect(d.finish('phone', 't1')).resolves.toEqual({ ok: true, value: 'hello there' })
    expect(voice.calls).toEqual(['start 16000', 'audio t1 4', 'audio t1 6', 'finish t1'])
  })

  it('says plainly when Voice Operator is not running', async () => {
    const d = new RemoteDictation(fakeVoice({ start: undefined }))
    const started = await d.start('phone', 16000)
    expect(started.ok).toBe(false)
    expect(!started.ok && started.error).toMatch(/not running/)
  })

  it('reports an audio failure at finish, and cancels rather than finishing', async () => {
    const voice = fakeVoice({ audio: { status: 404, body: { error: 'unknown_transcription' } } })
    const d = new RemoteDictation(voice)
    await d.start('phone', 16000)
    d.audio('phone', 't1', new Uint8Array(2))
    d.audio('phone', 't1', new Uint8Array(2))
    const result = await d.finish('phone', 't1')
    expect(result).toEqual({ ok: false, error: 'Voice Operator could not take the audio: unknown_transcription' })
    // Stops posting after the first failure.
    expect(voice.calls).toEqual(['start 16000', 'audio t1 2', 'cancel t1'])
  })

  it('will not let one client touch another’s dictation', async () => {
    const voice = fakeVoice()
    const d = new RemoteDictation(voice)
    await d.start('phone', 16000)
    d.audio('laptop', 't1', new Uint8Array(2))
    d.cancel('laptop', 't1')
    expect((await d.finish('laptop', 't1')).ok).toBe(false)
    expect(voice.calls).toEqual(['start 16000'])
  })

  it('cancels a disconnected client’s open dictations', async () => {
    const voice = fakeVoice()
    const d = new RemoteDictation(voice)
    await d.start('phone', 16000)
    d.cancelAllFor('phone')
    expect(voice.calls).toEqual(['start 16000', 'cancel t1'])
    expect((await d.finish('phone', 't1')).ok).toBe(false)
  })
})

describe('RemoteDictation, whether the speaker has finished', () => {
  /** s16le PCM of `seconds` at a constant level. */
  const pcm = (seconds: number, level: number) => {
    const out = new Uint8Array(seconds * 16_000 * 2)
    const view = new DataView(out.buffer)
    for (let i = 0; i < out.length / 2; i++) view.setInt16(i * 2, level, true)
    return out
  }

  it('asks the turn model about the audio received so far, at most its last eight seconds', async () => {
    const asked: Array<{ seconds: number; last: number }> = []
    const d = new RemoteDictation(fakeVoice(), {
      turnProbability: async (audio) => { asked.push({ seconds: audio.length / 16_000, last: audio[audio.length - 1] }); return 0.9 },
    })
    await d.start('phone', 16000)
    // As the phone sends it: a fifth of a second at a time.
    for (let i = 0; i < 30; i++) d.audio('phone', 't1', pcm(0.2, 1000))
    // Asked straight after the audio was sent: it is already counted.
    expect(await d.turnComplete('phone', 't1')).toEqual({ ok: true, value: 0.9 })
    for (let i = 0; i < 25; i++) d.audio('phone', 't1', pcm(0.2, 2000))
    await d.turnComplete('phone', 't1')
    expect(asked[0].seconds).toBeCloseTo(6, 5)
    expect(asked[1].seconds).toBeGreaterThanOrEqual(8)
    expect(asked[1].seconds).toBeLessThan(8.3)
    expect(asked[1].last).toBeCloseTo(2000 / 32768, 6)
  })

  it('answers null without a turn model, so the client falls back on silence', async () => {
    const d = new RemoteDictation(fakeVoice())
    await d.start('phone', 16000)
    expect(await d.turnComplete('phone', 't1')).toEqual({ ok: true, value: null })
  })
})

describe('RemoteDictation, whether the user is speaking', () => {
  it('says so from start until finish is asked for, or a cancel, and only on a change', async () => {
    const heard: boolean[] = []
    const d = new RemoteDictation(fakeVoice(), { onSpeaking: (speaking) => heard.push(speaking) })
    await d.start('phone', 16000)
    expect(d.speaking).toBe(true)
    const finishing = d.finish('phone', 't1')
    // Stopped talking at once, though transcription is still under way.
    expect(d.speaking).toBe(false)
    await finishing
    await d.start('phone', 16000)
    d.cancelAllFor('phone')
    expect(heard).toEqual([true, false, true, false])
  })

  it('for Control, goes on until its words are handed over, so Control neither resumes nor speaks without them', async () => {
    const heard: boolean[] = []
    const d = new RemoteDictation(fakeVoice(), { onSpeaking: (speaking) => heard.push(speaking), schedule: () => () => {} })
    await d.start('phone', 16000, true)
    await d.finish('phone', 't1')
    expect(d.speaking).toBe(true)
    d.delivered('someone else')
    expect(d.speaking).toBe(true)
    d.delivered('phone')
    expect(heard).toEqual([true, false])
  })

  it('for Control, ends with the transcription when it caught no words', async () => {
    const d = new RemoteDictation(fakeVoice({ finish: { status: 200, body: { text: '  ' } } }), { schedule: () => () => {} })
    await d.start('phone', 16000, true)
    await d.finish('phone', 't1')
    expect(d.speaking).toBe(false)
  })

  it('for Control, stops waiting on words that never come back', async () => {
    let limit: (() => void) | undefined
    const d = new RemoteDictation(fakeVoice(), {
      schedule: (ms, fn) => {
        expect(ms).toBe(WORDS_FOR_CONTROL_LIMIT_MS)
        limit = fn
        return () => {}
      },
    })
    await d.start('phone', 16000, true)
    await d.finish('phone', 't1')
    expect(d.speaking).toBe(true)
    limit?.()
    expect(d.speaking).toBe(false)
  })

  it('for Control, lets go when the phone goes away before handing the words over', async () => {
    const d = new RemoteDictation(fakeVoice(), { schedule: () => () => {} })
    await d.start('phone', 16000, true)
    await d.finish('phone', 't1')
    d.cancelAllFor('phone')
    expect(d.speaking).toBe(false)
  })
})
