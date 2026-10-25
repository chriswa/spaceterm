import { describe, expect, it, vi } from 'vitest'
import { SpeechLinks, SPEAKER_WAIT_MS } from './voice-operator-speech'
import type { LineConnection } from './voice-operator-hands-free'
import type { SpeechBackend, VoiceOperator } from './voice-operator'
import type { ServerMessage } from '../shared/protocol'

/** A phone's speaker connection through the server, Voice Operator played by each test. */
function harness(opts: { voiceOperatorUp?: boolean } = {}) {
  const sent: ServerMessage[] = []
  const written: string[] = []
  const records: Array<[string, Record<string, unknown>]> = []
  let fromVoiceOperator: (line: string) => void = () => {}
  let closedByVoiceOperator: () => void = () => {}
  let closed = 0
  let wake: () => void = () => {}
  const links = new SpeechLinks({
    connect: (onLine, onClose) => {
      if (opts.voiceOperatorUp === false) return undefined
      fromVoiceOperator = onLine
      closedByVoiceOperator = onClose
      const connection: LineConnection = { write: (line) => written.push(line), close: () => { closed++ } }
      return connection
    },
    send: (_clientId, msg) => sent.push(msg),
    record: (_clientId, kind, detail) => records.push([kind, detail]),
    sleep: () => new Promise((resolve) => { wake = resolve }),
  })
  const voiceOperator = {
    speak: vi.fn(async () => ({ status: 202, body: { id: 'ds_1234567890abc', state: 'in_progress' } })),
    status: vi.fn(async () => ({ status: 200, body: { id: 'ds_1', state: 'completed' } })),
    drop: vi.fn(async () => ({ status: 410, body: { id: 'ds_1', state: 'cancelled_by_client' } })),
  }
  const fallback: SpeechBackend = {
    speak: vi.fn(async () => ({ status: 410, body: { error: 'no_listener' } })),
    status: vi.fn(async () => ({ status: 404, body: {} })),
    drop: vi.fn(async () => ({ status: 404, body: {} })),
  }
  const backend = links.backend('phone-client', 'phone-abc', voiceOperator as unknown as VoiceOperator, fallback)
  return {
    links, backend, voiceOperator, fallback, sent, written, records,
    voiceOperatorSays: (message: Record<string, unknown>) => fromVoiceOperator(JSON.stringify(message)),
    voiceOperatorCloses: () => closedByVoiceOperator(),
    closed: () => closed,
    timeOut: () => wake(),
  }
}

describe('SpeechLinks', () => {
  it('carries the phone\'s lines to Voice Operator and back, unread', () => {
    const h = harness()
    h.links.open('phone-client')
    h.links.line('phone-client', '{"type":"hello","role":"speaker"}')
    h.voiceOperatorSays({ type: 'welcome', protocol: 1 })
    expect(h.written).toEqual(['{"type":"hello","role":"speaker"}'])
    expect(h.sent).toEqual([{ type: 'speech-link', kind: 'line', line: '{"type":"welcome","protocol":1}' }])
  })

  it('tells the phone when there is no Voice Operator, or it closes the connection', () => {
    const down = harness({ voiceOperatorUp: false })
    down.links.open('phone-client')
    expect(down.sent).toEqual([{ type: 'speech-link', kind: 'closed' }])
    const h = harness()
    h.links.open('phone-client')
    h.voiceOperatorSays({ type: 'welcome' })
    h.voiceOperatorCloses()
    expect(h.sent.at(-1)).toEqual({ type: 'speech-link', kind: 'closed' })
    expect(h.links.ready('phone-client')).toBe(false)
  })

  it('speaks on the phone once Voice Operator has welcomed its speaker, addressed to the device', async () => {
    const h = harness()
    h.links.open('phone-client')
    h.voiceOperatorSays({ type: 'welcome' })
    const response = await h.backend.speak('Hello there.', 'af_heart')
    expect(response?.status).toBe(202)
    expect(h.voiceOperator.speak).toHaveBeenCalledWith('Hello there.', 'af_heart', undefined, { client: 'spaceterm', device: 'phone-abc' })
    expect(h.records[0]).toEqual(['speech-job', { id: 'ds_12345678', chars: 12 }])
  })

  it('waits for a speaker on its way, then speaks', async () => {
    const h = harness()
    h.links.open('phone-client')
    const speaking = h.backend.speak('Hello.')
    h.voiceOperatorSays({ type: 'welcome' })
    await speaking
    expect(h.voiceOperator.speak).toHaveBeenCalled()
    expect(h.fallback.speak).not.toHaveBeenCalled()
  })

  it(`gives up after ${SPEAKER_WAIT_MS} ms, and nobody hears it`, async () => {
    const h = harness()
    h.links.open('phone-client')
    const speaking = h.backend.speak('Hello.')
    h.timeOut()
    expect((await speaking)?.status).toBe(410)
    expect(h.voiceOperator.speak).not.toHaveBeenCalled()
  })

  it('without a speaker at all, nobody hears it', async () => {
    const h = harness()
    await h.backend.speak('Hello.')
    expect(h.fallback.speak).toHaveBeenCalledWith('Hello.', undefined)
    expect(h.voiceOperator.speak).not.toHaveBeenCalled()
  })

  it('follows and stops every job at Voice Operator', async () => {
    const h = harness()
    await h.backend.status('ds_1', { wait: 5, since: 2 })
    await h.backend.drop('ds_1', 1234)
    expect(h.voiceOperator.status).toHaveBeenCalledWith('ds_1', { wait: 5, since: 2 }, undefined, undefined)
    expect(h.voiceOperator.drop).toHaveBeenCalledWith('ds_1', 1234)
  })

  it('keeps the phone\'s record of each sentence sent and each job ended', () => {
    const h = harness()
    h.links.open('phone-client')
    h.voiceOperatorSays({ type: 'sentence', id: 'ds_1234567890abc', index: 0, count: 2, pcm: 'A'.repeat(4096), synthMs: 210 })
    h.voiceOperatorSays({ type: 'ended', id: 'ds_1234567890abc', state: 'completed', characterOffset: 40 })
    expect(h.records).toEqual([
      ['speech-audio-sent', { id: 'ds_12345678', index: 0, count: 2, kb: 4, synthMs: 210 }],
      ['speech-job-ended', { id: 'ds_12345678', state: 'completed', heardChars: 40 }],
    ])
  })

  it('closing, or reopening, closes Voice Operator\'s side: what was playing ends where it got to', () => {
    const h = harness()
    h.links.open('phone-client')
    h.links.open('phone-client')
    expect(h.closed()).toBe(1)
    h.links.close('phone-client')
    expect(h.closed()).toBe(2)
    expect(h.sent).toEqual([])
  })

  it('a replaced speaker is not spoken to', async () => {
    const h = harness()
    h.links.open('phone-client')
    h.voiceOperatorSays({ type: 'welcome' })
    h.voiceOperatorSays({ type: 'replaced' })
    expect(h.links.ready('phone-client')).toBe(false)
  })
})
