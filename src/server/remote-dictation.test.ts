import { describe, it, expect } from 'vitest'
import { RemoteDictation, WORDS_FOR_CONTROL_LIMIT_MS } from './remote-dictation'
import { DICTATION_RESUME_GRACE_MS } from '../shared/dictation-resume'
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

/** Timers the test fires by hand: each one's length, and whether it was called off. */
function fakeClock() {
  const timers: Array<{ ms: number; fn: () => void; off: boolean }> = []
  return {
    timers,
    schedule: (ms: number, fn: () => void) => {
      const timer = { ms, fn, off: false }
      timers.push(timer)
      return () => { timer.off = true }
    },
    /** Fire every live timer of this length. */
    fire(ms: number) {
      for (const t of timers.filter((t) => t.ms === ms && !t.off)) {
        t.off = true
        t.fn()
      }
    },
  }
}

/** n samples of s16 PCM, each sample's value its own offset, so what was relayed can be read back. */
function pcm(at: number, n: number): Uint8Array {
  const samples = Int16Array.from({ length: n }, (_, i) => at + i)
  return new Uint8Array(samples.buffer)
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

  it('cancels a disconnected client’s open dictation once the grace runs out', async () => {
    const voice = fakeVoice()
    const clock = fakeClock()
    const d = new RemoteDictation(voice, { schedule: clock.schedule })
    await d.start('phone', 16000)
    d.disconnected('phone')
    expect(voice.calls).toEqual(['start 16000'])
    clock.fire(DICTATION_RESUME_GRACE_MS)
    expect(voice.calls).toEqual(['start 16000', 'cancel t1'])
    expect(d.resume('phone', 't1').ok).toBe(false)
    expect((await d.finish('phone', 't1')).ok).toBe(false)
  })

  it('lets a device that comes back within the grace carry on from where the server got to', async () => {
    const voice = fakeVoice()
    const clock = fakeClock()
    const d = new RemoteDictation(voice, { schedule: clock.schedule })
    await d.start('phone', 16000)
    d.audio('phone', 't1', pcm(0, 100), 0)
    d.disconnected('phone')
    // Sent into the dying connection, never arrived: the phone resends from what the server says it has.
    expect(d.resume('phone', 't1')).toEqual({ ok: true, value: 100 })
    clock.fire(DICTATION_RESUME_GRACE_MS)
    d.audio('phone', 't1', pcm(100, 50), 100)
    await expect(d.finish('phone', 't1')).resolves.toEqual({ ok: true, value: 'hello there' })
    expect(voice.calls).toEqual(['start 16000', 'audio t1 200', 'audio t1 100', 'finish t1'])
  })

  it('takes each sample once: drops what it already has, and a chunk that would leave a gap', async () => {
    const sent: Uint8Array[] = []
    const voice = { ...fakeVoice(), async sendTranscriptionAudio(_id: string, chunk: Uint8Array) { sent.push(chunk); return { status: 204, body: undefined } } }
    const d = new RemoteDictation(voice)
    await d.start('phone', 16000)
    d.audio('phone', 't1', pcm(0, 4), 0)
    d.audio('phone', 't1', pcm(0, 4), 0) // all of it again
    d.audio('phone', 't1', pcm(2, 4), 2) // half again
    d.audio('phone', 't1', pcm(9, 2), 9) // a gap
    d.audio('phone', 't1', pcm(6, 2)) // no offset (protocol v24): straight after
    expect(d.resume('phone', 't1')).toEqual({ ok: true, value: 8 })
    await d.finish('phone', 't1')
    const relayed = sent.flatMap((chunk) => Array.from(new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2)))
    expect(relayed).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('answers a finish asked again — its reply lost with the connection — with the same words, transcribing once', async () => {
    const voice = fakeVoice()
    const clock = fakeClock()
    const d = new RemoteDictation(voice, { schedule: clock.schedule })
    await d.start('phone', 16000)
    await d.finish('phone', 't1')
    d.disconnected('phone')
    expect(d.resume('phone', 't1').ok).toBe(true)
    await expect(d.finish('phone', 't1')).resolves.toEqual({ ok: true, value: 'hello there' })
    expect(voice.calls).toEqual(['start 16000', 'finish t1'])
    clock.fire(DICTATION_RESUME_GRACE_MS)
    expect((await d.finish('phone', 't1')).ok).toBe(false)
  })

  it('does not let a stale connection’s late close cancel a dictation the device is carrying on with', async () => {
    const voice = fakeVoice()
    const clock = fakeClock()
    const d = new RemoteDictation(voice, { schedule: clock.schedule })
    await d.start('phone', 16000)
    d.disconnected('phone')
    d.audio('phone', 't1', pcm(0, 10), 0)
    clock.fire(DICTATION_RESUME_GRACE_MS)
    expect(voice.calls).not.toContain('cancel t1')
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
    d.cancel('phone', 't1')
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
        if (ms === WORDS_FOR_CONTROL_LIMIT_MS) limit = fn
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
    d.disconnected('phone')
    expect(d.speaking).toBe(false)
  })

  it('holds Control through a dropped connection while the user may still be talking, and lets go when the grace runs out', async () => {
    const clock = fakeClock()
    const d = new RemoteDictation(fakeVoice(), { schedule: clock.schedule })
    await d.start('phone', 16000, true)
    d.disconnected('phone')
    expect(d.speaking).toBe(true)
    clock.fire(DICTATION_RESUME_GRACE_MS)
    expect(d.speaking).toBe(false)
  })
})
