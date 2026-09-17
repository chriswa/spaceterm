import { describe, it, expect, vi } from 'vitest'
import { DirectSpeech } from './direct-speech'
import { VoiceOperator, type SpeechStatus } from './voice-operator'

/**
 * A stand-in Voice Operator, driven through the same HTTP seam the real client
 * uses — a fake `fetch` and a fake discovery file rather than a mocked module,
 * so these tests exercise the request this code actually sends.
 */
function fakeService(opts: {
  running?: boolean
  /** Status body for POST /v1/speech. Absent = the service declines. */
  accept?: Partial<SpeechStatus> | { error: string }
  /** Terminal status a polling monitor sees. */
  ends?: SpeechStatus['state']
} = {}) {
  const requests: Array<{ url: string; method: string; body?: unknown }> = []
  // Each accepted job gets its own id, as the real service does — two
  // utterances sharing one id would hide whether a stop dropped both.
  let nextJob = 0
  const accept = opts.accept
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    requests.push({
      url: String(url), method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    const body = method === 'POST'
      ? accept ?? { id: `job-${++nextJob}`, state: 'in_progress' as const }
      : { id: String(url).split('/v1/speech/')[1]?.split('?')[0], state: opts.ends ?? 'completed' }
    return { status: 200, json: async () => body } as unknown as Response
  }) as unknown as typeof fetch
  const vo = new VoiceOperator({
    fetch: fakeFetch,
    readDiscovery: () => (opts.running === false ? undefined : { port: 4444 }),
  })
  return { vo, requests }
}

function build(opts: Parameters<typeof fakeService>[0] = {}) {
  const { vo, requests } = fakeService(opts)
  const active: boolean[] = []
  const speech = new DirectSpeech({ vo, onActiveChanged: (a) => active.push(a) })
  return { speech, requests, active }
}

describe('DirectSpeech', () => {
  it('sends cleaned text to Voice Operator', async () => {
    const { speech, requests } = build()
    // The "⏺" prefix is Claude Code decoration; reading it aloud is never meant.
    expect(await speech.speak('⏺ hello there')).toBe('started')
    const post = requests.find(r => r.method === 'POST')
    expect(post?.url).toBe('http://127.0.0.1:4444/v1/speech')
    expect((post?.body as { text: string }).text).not.toContain('⏺')
    expect((post?.body as { text: string }).text).toContain('hello there')
  })

  it('says nothing when the text cleans down to nothing', async () => {
    const { speech, requests } = build()
    expect(await speech.speak('   ')).toBe('empty')
    expect(requests).toHaveLength(0)
  })

  it('reports a service that is not running rather than reporting silence', async () => {
    const { speech } = build({ running: false })
    expect(await speech.speak('hello')).toBe('unavailable')
  })

  it('distinguishes a muted service from a broken one', async () => {
    const { speech } = build({ accept: { error: 'speech_muted' } })
    expect(await speech.speak('hello')).toBe('muted')
  })

  it('announces active only on the first of several overlapping jobs', async () => {
    const { speech, active } = build({ ends: 'in_progress' })
    await speech.speak('one')
    await speech.speak('two')
    expect(active).toEqual([true])
  })

  it('drops every live job on stop, and settles', async () => {
    const { speech, requests, active } = build({ ends: 'in_progress' })
    await speech.speak('one')
    await speech.speak('two')
    await speech.stop()
    const deletes = requests.filter(r => r.method === 'DELETE')
    expect(deletes).toHaveLength(2)
    expect(speech.isActive()).toBe(false)
    expect(active).toEqual([true, false])
  })

  it('toggles: speaks when silent, stops when speaking', async () => {
    const { speech, requests } = build({ ends: 'in_progress' })
    expect(await speech.toggle('hello')).toBe('started')
    expect(await speech.toggle('hello again')).toBe('stopped')
    expect(requests.filter(r => r.method === 'POST')).toHaveLength(1)
    expect(requests.filter(r => r.method === 'DELETE')).toHaveLength(1)
  })

  it('a press made while silent speaks, even after an earlier job finished', async () => {
    const { speech } = build({ ends: 'completed' })
    await speech.toggle('hello')
    // The monitor observes the terminal status and settles on its own; without
    // that, a toggle after speech ended would read as "still speaking" and the
    // next press would silently stop nothing.
    await vi.waitFor(() => expect(speech.isActive()).toBe(false))
    expect(await speech.toggle('again')).toBe('started')
  })
})
