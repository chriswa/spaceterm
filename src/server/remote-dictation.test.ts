import { describe, it, expect } from 'vitest'
import { RemoteDictation } from './remote-dictation'
import type { SpeechResponse } from './voice-operator'

/** Voice Operator as a script: what it answers, and a log of what it was asked. */
function fakeVoice(overrides: Partial<Record<'start' | 'audio' | 'finish', SpeechResponse>> = {}) {
  const calls: string[] = []
  const voice = {
    calls,
    async startTranscription(rate: number, watch?: string) {
      calls.push(`start ${rate}${watch ? ` watching "${watch}"` : ''}`)
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

describe('RemoteDictation, an end phrase', () => {
  it('tells the client once when Voice Operator hears it, and still finishes normally', async () => {
    const ended: string[] = []
    const voice = fakeVoice({ audio: { status: 200, body: { heard: true } } })
    const d = new RemoteDictation(voice, () => {}, (owner, id) => ended.push(`${owner} ${id}`))
    await d.start('phone', 16000, 'over and out')
    d.audio('phone', 't1', new Uint8Array(2))
    d.audio('phone', 't1', new Uint8Array(2))
    await expect(d.finish('phone', 't1')).resolves.toEqual({ ok: true, value: 'hello there' })
    expect(ended).toEqual(['phone t1'])
    expect(voice.calls[0]).toBe('start 16000 watching "over and out"')
  })
})

describe('RemoteDictation, whether the user is speaking', () => {
  it('says so from start until finish is asked for, or a cancel, and only on a change', async () => {
    const heard: boolean[] = []
    const d = new RemoteDictation(fakeVoice(), (speaking) => heard.push(speaking))
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
})
