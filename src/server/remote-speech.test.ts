import { describe, it, expect, vi } from 'vitest'
import { RemoteSpeech, splitSentences, splitSpeech } from './remote-speech'
import { redactUnheard } from './unheard'
import { joinSpeechParts, parseTimedSynthesis, parseWav, speechStatus, type SpeechBackend, type TimedWord } from './voice-operator'
import type { ServerMessage } from '../shared/protocol'

const PHONE = 'phone-client'

function harness(opts: { connected?: boolean; synthesize?: (text: string) => Uint8Array | undefined; words?: (text: string) => TimedWord[] | undefined } = {}) {
  const sent: ServerMessage[] = []
  let connected = opts.connected ?? true
  let ids = 0
  const synthesized: Array<[string, string | undefined]> = []
  const speech = new RemoteSpeech({
    synthesize: async (text, voice) => {
      synthesized.push([text, voice])
      const pcm = opts.synthesize ? opts.synthesize(text) : new Uint8Array(4)
      const words = opts.words?.(text)
      return pcm && { pcm, sampleRate: 24000, ...(words ? { words } : {}) }
    },
    send: (_clientId, msg) => {
      if (!connected) return false
      sent.push(msg)
      return true
    },
    isConnected: () => connected,
    newId: () => `rs_${++ids}`,
  })
  const fallback: SpeechBackend = {
    speak: vi.fn(async () => ({ status: 202, body: { id: 'sp_mac', state: 'in_progress' } })),
    status: vi.fn(async () => ({ status: 200, body: { id: 'sp_mac', state: 'completed' } })),
    drop: vi.fn(async () => ({ status: 410, body: { id: 'sp_mac', state: 'cancelled_by_client' } })),
  }
  const backend = speech.forClient(PHONE, fallback)
  return { speech, backend, fallback, sent, synthesized, disconnect: () => { connected = false } }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const TEXT = 'The agent fixed the bug. It also added a test! Anything else?'

describe('splitSentences', () => {
  it('keeps each sentence with its place in the text', () => {
    const sentences = splitSentences(TEXT)
    expect(sentences.map((s) => s.text)).toEqual(['The agent fixed the bug.', 'It also added a test!', 'Anything else?'])
    for (const s of sentences) expect(TEXT.slice(s.start, s.end)).toBe(s.text)
  })

  it('keeps an unterminated tail', () => {
    expect(splitSentences('One. Two').map((s) => s.text)).toEqual(['One.', 'Two'])
  })
})

describe('splitSpeech', () => {
  it('segments each part on its own and indexes the single-space join', () => {
    // An unterminated part must not run on into the next one.
    const parts = [{ text: 'First part', voice: 'a' }, { text: '  Ünïcødé — 🙂 ok. Last!' }, { text: 'Tail' }]
    const joined = joinSpeechParts(parts)
    const sentences = splitSpeech(parts, 'fallback')
    expect(sentences.map((s) => [s.text, s.voice])).toEqual([
      ['First part', 'a'], ['Ünïcødé — 🙂 ok.', 'fallback'], ['Last!', 'fallback'], ['Tail', 'fallback'],
    ])
    for (const s of sentences) expect(joined.slice(s.start, s.end)).toBe(s.text)
  })

  it('treats plain text as one part in the given voice', () => {
    expect(splitSpeech(TEXT, 'v')).toEqual(splitSentences(TEXT).map((s) => ({ ...s, voice: 'v' })))
    expect(splitSpeech(TEXT)[0]).not.toHaveProperty('voice')
  })
})

describe('RemoteSpeech', () => {
  it('sends each sentence to the phone, in order, as Voice Operator would accept a job', async () => {
    const h = harness()
    const job = speechStatus(await h.backend.speak(TEXT))
    expect(job).toMatchObject({ id: 'rs_1', state: 'in_progress', playback_state: 'queued' })
    await settle()
    expect(h.sent.map((m) => m.type === 'speech-audio' && [m.index, m.count])).toEqual([[0, 3], [1, 3], [2, 3]])
  })

  it('is speaking once the phone starts, has heard what it finished, and completes on the last', async () => {
    const h = harness()
    await h.backend.speak(TEXT)
    await settle()
    h.speech.progress(PHONE, 'rs_1', 0, 'started')
    expect(speechStatus(await h.backend.status('rs_1'))?.playback_state).toBe('speaking')
    h.speech.progress(PHONE, 'rs_1', 0, 'finished')
    expect(speechStatus(await h.backend.status('rs_1'))?.character_offset).toBe('The agent fixed the bug. '.length)
    h.speech.progress(PHONE, 'rs_1', 1, 'finished')
    h.speech.progress(PHONE, 'rs_1', 2, 'finished')
    expect(speechStatus(await h.backend.status('rs_1'))).toMatchObject({ state: 'completed', character_offset: TEXT.length })
  })

  it('a long poll with a cursor wakes on the next change', async () => {
    const h = harness()
    const job = speechStatus(await h.backend.speak(TEXT))!
    const poll = h.backend.status('rs_1', { wait: 30, since: job.version })
    h.speech.progress(PHONE, 'rs_1', 0, 'started')
    expect(speechStatus(await poll)?.playback_state).toBe('speaking')
  })

  it('dropping stops the phone and reports how far the listener got, as Voice Operator does', async () => {
    const h = harness()
    await h.backend.speak(TEXT)
    await settle()
    h.speech.progress(PHONE, 'rs_1', 0, 'finished')
    const dropped = await h.backend.drop('rs_1')
    expect(dropped?.status).toBe(410)
    expect(speechStatus(dropped)).toMatchObject({ state: 'cancelled_by_client', character_offset: 25 })
    expect(h.sent.at(-1)).toEqual({ type: 'speech-stop', id: 'rs_1' })
  })

  it('a sentence that cannot be synthesized fails the job', async () => {
    const h = harness({ synthesize: (text) => text.startsWith('It') ? undefined : new Uint8Array(4) })
    await h.backend.speak(TEXT)
    await settle()
    expect(speechStatus(await h.backend.status('rs_1'))?.state).toBe('synthesis_failed')
  })

  it('the phone going away ends its job where it got to', async () => {
    const h = harness()
    await h.backend.speak(TEXT)
    h.speech.clientGone(PHONE)
    expect(speechStatus(await h.backend.status('rs_1'))?.state).toBe('cancelled_by_client')
  })

  it('speaks on the Mac when the phone is not connected, and follows that job there', async () => {
    const h = harness({ connected: false })
    expect(speechStatus(await h.backend.speak(TEXT))?.id).toBe('sp_mac')
    await h.backend.drop('sp_mac')
    expect(h.fallback.drop).toHaveBeenCalledWith('sp_mac')
  })

  it('speaks parts sentence by sentence, each in its own voice, with offsets into the joined text', async () => {
    const h = harness()
    const parts = [{ text: 'Hello caller. How can I help?', voice: 'af_bella' }, { text: 'Connecting you now.' }]
    await h.backend.speak(parts, 'am_adam')
    await settle()
    expect(h.synthesized).toEqual([
      ['Hello caller.', 'af_bella'], ['How can I help?', 'af_bella'], ['Connecting you now.', 'am_adam'],
    ])
    // Finishing the first part is an offset that lands at its end in the joined text.
    h.speech.progress(PHONE, 'rs_1', 1, 'finished')
    const joined = joinSpeechParts(parts)
    const offset = speechStatus(await h.backend.status('rs_1'))!.character_offset!
    expect(joined.slice(0, offset)).toBe('Hello caller. How can I help? ')
    h.speech.progress(PHONE, 'rs_1', 2, 'finished')
    expect(speechStatus(await h.backend.status('rs_1'))).toMatchObject({ state: 'completed', character_offset: joined.length })
  })

  it('a finished sentence is heard whole, not cut in its last word', async () => {
    const h = harness()
    await h.backend.speak(TEXT)
    await settle()
    h.speech.progress(PHONE, 'rs_1', 0, 'finished')
    const offset = speechStatus(await h.backend.drop('rs_1'))!.character_offset!
    expect(redactUnheard(TEXT, offset)).toBe('The agent fixed the bug. *INTERRUPTED*')
  })

  describe('a cut part way through a sentence', () => {
    const QUESTION = "That's a change to the app, so an agent should do it. Want me to send it to Tessa, or start a new agent?"
    /** Each word a third of a second, the first at zero: Kokoro's timings, as Voice Operator aligns them. */
    const timed = (text: string): TimedWord[] =>
      [...text.matchAll(/[\w']+/g)].map((m, i) => ({ start: i / 3, characterEnd: m.index + m[0].length }))
    // Four seconds of audio a sentence: 24000 samples a second, two bytes a sample.
    const fourSeconds = () => new Uint8Array(4 * 24000 * 2)

    /** Play the first sentence, then cut in `seconds` into the second. */
    async function cutInto(seconds: number, words?: typeof timed) {
      const h = harness({ synthesize: fourSeconds, words })
      await h.backend.speak(QUESTION)
      await settle()
      const now = Date.now()
      h.speech.progress(PHONE, 'rs_1', 0, 'started', now - 4000 - seconds * 1000)
      h.speech.progress(PHONE, 'rs_1', 0, 'finished', now - seconds * 1000)
      h.speech.progress(PHONE, 'rs_1', 1, 'started', now - seconds * 1000)
      return redactUnheard(QUESTION, speechStatus(await h.backend.drop('rs_1'))!.character_offset!)
    }

    it('is heard up to the word that was sounding', async () => {
      // "Tessa" is the seventh word: it starts at two seconds.
      expect(await cutInto(2.1, timed)).toBe("That's a change to the app, so an agent should do it. Want me to send it to *INTERRUPTED*")
      expect(await cutInto(2.4, timed)).toBe("That's a change to the app, so an agent should do it. Want me to send it to Tessa, *INTERRUPTED*")
    })

    it('reports the word sounding now to a status read mid-speech, as Voice Operator does', async () => {
      const h = harness({ synthesize: fourSeconds, words: timed })
      await h.backend.speak(QUESTION)
      await settle()
      const now = Date.now()
      h.speech.progress(PHONE, 'rs_1', 0, 'started', now - 4000 - 2400)
      h.speech.progress(PHONE, 'rs_1', 0, 'finished', now - 2400)
      h.speech.progress(PHONE, 'rs_1', 1, 'started', now - 2400)
      const live = speechStatus(await h.backend.status('rs_1'))!
      expect(live.state).toBe('in_progress')
      expect(redactUnheard(QUESTION, live.character_offset!)).toBe("That's a change to the app, so an agent should do it. Want me to send it to Tessa, *INTERRUPTED*")
    })

    it('without word timings, counts none of it rather than guessing', async () => {
      expect(await cutInto(2.1)).toBe("That's a change to the app, so an agent should do it. *INTERRUPTED*")
    })
  })

  it('a sentence the phone has not yet started is not counted', async () => {
    const h = harness()
    await h.backend.speak(TEXT)
    await settle()
    h.speech.progress(PHONE, 'rs_1', 0, 'finished')
    h.speech.clientGone(PHONE)
    expect(speechStatus(await h.backend.status('rs_1'))?.character_offset).toBe('The agent fixed the bug. '.length)
  })

  it('ignores another client reporting on a job it does not own', async () => {
    const h = harness()
    await h.backend.speak(TEXT)
    h.speech.progress('someone-else', 'rs_1', 0, 'started')
    expect(speechStatus(await h.backend.status('rs_1'))?.playback_state).toBe('queued')
  })
})

describe('parseTimedSynthesis', () => {
  const wavBase64 = () => {
    const out = new Uint8Array(44 + 4)
    const view = new DataView(out.buffer)
    out.set(new TextEncoder().encode('RIFF'), 0)
    out.set(new TextEncoder().encode('WAVEfmt '), 8)
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, 24000, true)
    view.setUint16(34, 16, true)
    out.set(new TextEncoder().encode('data'), 36)
    view.setUint32(40, 4, true)
    return Buffer.from(out).toString('base64')
  }

  it('reads the audio and each word', () => {
    const parsed = parseTimedSynthesis({ audio: wavBase64(), words: [{ start: 0, end: 0.2, character_end: 5 }] })
    expect(parsed).toMatchObject({ sampleRate: 24000, words: [{ start: 0, characterEnd: 5 }] })
    expect(parsed?.pcm.length).toBe(4)
  })

  it('keeps the audio but no words when any word is malformed', () => {
    const parsed = parseTimedSynthesis({ audio: wavBase64(), words: [{ start: 0, character_end: 5 }, { start: 1 }] })
    expect(parsed).toBeDefined()
    expect(parsed?.words).toBeUndefined()
  })
})

describe('parseWav', () => {
  function wav(samples: number[], sampleRate = 24000): Uint8Array {
    const data = new Int16Array(samples)
    const out = new Uint8Array(44 + data.byteLength)
    const view = new DataView(out.buffer)
    const tag = (at: number, s: string) => [...s].forEach((c, i) => { out[at + i] = c.charCodeAt(0) })
    tag(0, 'RIFF'); view.setUint32(4, 36 + data.byteLength, true); tag(8, 'WAVE')
    tag(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
    tag(36, 'data'); view.setUint32(40, data.byteLength, true)
    out.set(new Uint8Array(data.buffer), 44)
    return out
  }

  it('finds the samples and the rate', () => {
    const parsed = parseWav(wav([1, -2, 3]))
    expect(parsed?.sampleRate).toBe(24000)
    expect([...new Int16Array(parsed!.pcm.buffer.slice(0))]).toEqual([1, -2, 3])
  })

  it('refuses what is not a WAV', () => {
    expect(parseWav(new Uint8Array(50))).toBeUndefined()
  })
})

describe('RemoteSpeech, two jobs at once', () => {
  it('sends the second job only after every sentence of the first', async () => {
    const h = harness()
    await Promise.all([h.backend.speak('Let me check. One moment.'), h.backend.speak('Kevin finished. The tests pass.')])
    await settle()
    await settle()
    expect(h.sent.map((m) => m.type === 'speech-audio' && `${m.id}:${m.index}`)).toEqual(['rs_1:0', 'rs_1:1', 'rs_2:0', 'rs_2:1'])
  })

  it('never synthesizes a job dropped while it waited its turn', async () => {
    const h = harness()
    await h.backend.speak('Let me check.')
    const second = speechStatus(await h.backend.speak('Never heard.'))!
    await h.backend.drop(second.id!)
    await settle()
    await settle()
    expect(h.synthesized.map(([text]) => text)).toEqual(['Let me check.'])
  })
})
