import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteSpeechApi } from '../shared/api'

/** The app's bridge, faked: what the page posts to it, and a way to answer as it does. */
function fakeApp({ speech, voiceProcessing = speech }: { speech: boolean; voiceProcessing?: boolean }) {
  const posted: Array<Record<string, unknown>> = []
  ;(window as unknown as { webkit: unknown }).webkit = { messageHandlers: { nativeMicrophone: { postMessage: (m: Record<string, unknown>) => posted.push(m) } } }
  return {
    posted,
    /** The app's microphone is up, and says whether it can play speech. */
    running: () => window.spacetermNativeMicrophone?.state({ running: true, input: 'iPhone Microphone', speech, voiceProcessing }),
    /** Up without the microphone, keeping the app awake: no echo cancellation, and none needed. */
    awake: () => window.spacetermNativeMicrophone?.state({ running: false, awake: true, speech, voiceProcessing: false }),
    event: (id: string, index: number, event: 'started' | 'finished' | 'failed') => window.spacetermNativeMicrophone?.speech({ id, index, event, outputDb: -18 }),
  }
}

function fakeApi() {
  let onAudio: Parameters<RemoteSpeechApi['onAudio']>[0] = () => {}
  let onStop: (id: string) => void = () => {}
  const progress: string[] = []
  const api: RemoteSpeechApi = {
    onAudio: (cb) => { onAudio = cb; return () => {} },
    onStop: (cb) => { onStop = cb; return () => {} },
    progress: (id, index, event) => { progress.push(`${id} ${index} ${event}`) },
  }
  return {
    api, progress,
    sentence: (id: string, index: number, count: number) => onAudio({ id, index, count, sampleRate: 24_000, pcm: 'AAAA' }),
    stop: (id: string) => onStop(id),
  }
}

async function load() {
  vi.resetModules()
  ;(window as unknown as { api: unknown }).api = { log: () => {} }
  delete (window as unknown as { spacetermNativeMicrophone?: unknown }).spacetermNativeMicrophone
  return import('./speech-player')
}

let stopPlayer: (() => void) | undefined
beforeEach(() => vi.stubGlobal('AudioContext', undefined))
afterEach(() => { stopPlayer?.(); stopPlayer = undefined; vi.unstubAllGlobals() })

describe('speech in the app', () => {
  it('goes to the app to play, with echo cancellation, and its progress goes to the server as before', async () => {
    const app = fakeApp({ speech: true })
    const { startSpeechPlayer, nativePlayback } = await load()
    const remote = fakeApi()
    stopPlayer = startSpeechPlayer(remote.api, () => {})
    app.running()
    remote.sentence('rs_1', 0, 2)
    remote.sentence('rs_1', 1, 2)
    expect(app.posted.filter((m) => m.action === 'speech-play').map((m) => m.index)).toEqual([0, 1])
    expect(nativePlayback.playing()).toBe(true)
    app.event('rs_1', 0, 'started')
    app.event('rs_1', 0, 'finished')
    app.event('rs_1', 1, 'started')
    app.event('rs_1', 1, 'finished')
    expect(remote.progress).toEqual(['rs_1 0 started', 'rs_1 0 finished', 'rs_1 1 started', 'rs_1 1 finished'])
    expect(nativePlayback.playing()).toBe(false)
    expect(nativePlayback.outputDb()).toBe(-18)
  })

  it('is cut off in the app when the server stops it', async () => {
    const app = fakeApp({ speech: true })
    const { startSpeechPlayer, nativePlayback } = await load()
    const remote = fakeApi()
    stopPlayer = startSpeechPlayer(remote.api, () => {})
    app.running()
    remote.sentence('rs_2', 0, 3)
    remote.stop('rs_2')
    expect(app.posted.at(-1)).toEqual({ action: 'speech-stop', id: 'rs_2' })
    expect(nativePlayback.playing()).toBe(false)
  })

  it('stays in the page when the app is running without echo cancellation', async () => {
    const app = fakeApp({ speech: true, voiceProcessing: false })
    const { startSpeechPlayer } = await load()
    const remote = fakeApi()
    stopPlayer = startSpeechPlayer(remote.api, () => {})
    app.running()
    remote.sentence('rs_4', 0, 1)
    expect(app.posted.some((m) => m.action === 'speech-play')).toBe(false)
  })

  it('goes to the app while it only keeps itself awake, with nobody listening to hear it', async () => {
    const app = fakeApp({ speech: true })
    const { startSpeechPlayer } = await load()
    const remote = fakeApi()
    stopPlayer = startSpeechPlayer(remote.api, () => {})
    app.awake()
    remote.sentence('rs_5', 0, 1)
    expect(app.posted.filter((m) => m.action === 'speech-play').map((m) => m.id)).toEqual(['rs_5'])
    app.event('rs_5', 0, 'started')
    app.event('rs_5', 0, 'finished')
    expect(remote.progress).toEqual(['rs_5 0 started', 'rs_5 0 finished'])
  })

  it('stays in the page with an app too old to play it', async () => {
    const app = fakeApp({ speech: false })
    const { startSpeechPlayer } = await load()
    const remote = fakeApi()
    stopPlayer = startSpeechPlayer(remote.api, () => {})
    app.running()
    remote.sentence('rs_3', 0, 1)
    expect(app.posted.some((m) => m.action === 'speech-play')).toBe(false)
    // No Web Audio in this test: the page's own player reports it could not play.
    expect(remote.progress).toEqual(['rs_3 0 failed'])
  })
})
