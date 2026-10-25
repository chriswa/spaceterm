import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { DictationApi } from '../shared/api'
import type { Capture } from './held-microphone'
import { DICTATION_RESUME_GRACE_MS } from '../shared/protocol'
import { ConnectionLostError } from '../shared/server-client'
import { AudioStats, CONNECTION_GONE, Dictation, NO_AUDIO_TIMEOUT_MS, whenHearing } from './dictation'

describe('AudioStats', () => {
  it('tells a microphone that sent nothing from one that sent silence', () => {
    expect(new AudioStats().describe(48000)).toBe('0 blocks, 0.0s, peak silent')
    const zeros = new AudioStats()
    zeros.push(new Float32Array(48000))
    expect(zeros.describe(48000)).toBe('1 blocks, 1.0s, peak silent')
  })

  it('reports the loudest sample in dBFS', () => {
    const stats = new AudioStats()
    stats.push(Float32Array.from([0.01, -0.5, 0.1]))
    expect(stats.peak).toBe(0.5)
    expect(stats.describe(48000)).toMatch(/peak -6 dBFS$/)
  })
})

/** A capture that sends audio only when told to. */
function fakeCapture(sampleRate = 16_000) {
  const listeners = new Set<(block: Float32Array) => void>()
  let released: boolean | undefined
  const capture: Capture = {
    sampleRate,
    listen(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    healthy: () => released === undefined,
    release(broken = false) { released = broken },
    describe: () => 'fake',
  }
  return {
    capture,
    speak: () => { for (const fn of listeners) fn(new Float32Array(1600).fill(0.1)) },
    /** A dead input: blocks arrive, every sample exactly zero. */
    sendZeros: () => { for (const fn of listeners) fn(new Float32Array(1600)) },
    listening: () => listeners.size,
    released: () => released,
  }
}

function fakeApi(): DictationApi & { sent: number } {
  const api = {
    sent: 0,
    start: () => Promise.resolve('session'),
    audio: () => { api.sent++ },
    finish: () => Promise.resolve('words'),
    cancel: () => undefined,
    resume: () => Promise.resolve(0),
    isConnected: () => true,
    onConnect: () => () => undefined,
  }
  return api
}

describe('whenHearing', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('carries a dictation over to another microphone when the first sends nothing', async () => {
    const silent = fakeCapture(48_000)
    const other = fakeCapture()
    const replaceSilent = vi.fn(async (capture: Capture) => {
      capture.release(true)
      return other.capture
    })
    const api = fakeApi()
    const hearing = whenHearing(Dictation.begin(api, {}, { acquire: async () => silent.capture, replaceSilent }))

    await vi.advanceTimersByTimeAsync(NO_AUDIO_TIMEOUT_MS)
    expect(replaceSilent).toHaveBeenCalledWith(silent.capture)
    expect(silent.listening()).toBe(0)
    other.speak()
    const dictation = await hearing

    expect(silent.released()).toBe(true)
    await vi.advanceTimersByTimeAsync(500)
    expect(api.sent).toBeGreaterThan(0)
    await expect(dictation.finish()).resolves.toBe('words')
    // The stand-in is the one this dictation closes.
    expect(other.released()).toBe(false)
  })

  it('gives up, closing the silent microphone, when there is nothing else to try', async () => {
    const silent = fakeCapture()
    const hearing = whenHearing(Dictation.begin(fakeApi(), {}, { acquire: async () => silent.capture, replaceSilent: async () => undefined }))
    const failed = expect(hearing).rejects.toThrow(/not sending any sound/)
    await vi.advanceTimersByTimeAsync(NO_AUDIO_TIMEOUT_MS)
    await failed
    expect(silent.released()).toBe(true)
  })

  it('counts a microphone sending only exact zeros as sending nothing', async () => {
    const dead = fakeCapture()
    const hearing = whenHearing(Dictation.begin(fakeApi(), {}, { acquire: async () => dead.capture, replaceSilent: async () => undefined }))
    const failed = expect(hearing).rejects.toThrow(/only silence/)
    for (let i = 0; i < 20; i++) {
      dead.sendZeros()
      await vi.advanceTimersByTimeAsync(100)
    }
    await failed
    expect(dead.released()).toBe(true)
  })

  it('gives up when the stand-in is silent too', async () => {
    const silent = fakeCapture()
    const other = fakeCapture()
    const hearing = whenHearing(Dictation.begin(fakeApi(), {}, { acquire: async () => silent.capture, replaceSilent: async () => other.capture }))
    const failed = expect(hearing).rejects.toThrow(/not sending any sound/)
    await vi.advanceTimersByTimeAsync(NO_AUDIO_TIMEOUT_MS + 5000)
    await failed
    expect(other.released()).toBe(true)
  })
})

/**
 * The server as the dictation sees it through a connection that drops: it
 * takes audio only while connected, as the real one takes each sample once
 * (remote-dictation.ts), and says how much it has when resumed.
 */
function droppingServer() {
  const listeners = new Set<() => void>()
  const server = {
    connected: true,
    /** Samples the server has. */
    received: 0,
    resumes: 0,
    /** What the next finish does, before answering. */
    onFinish: (): Promise<string> => Promise.resolve('words'),
    drop() { server.connected = false },
    reconnect() {
      server.connected = true
      for (const listener of [...listeners]) listener()
    },
    resume: (): Promise<number> => {
      server.resumes++
      return Promise.resolve(server.received)
    },
  }
  const api: DictationApi = {
    start: () => Promise.resolve('session'),
    audio: (_id, pcm, at) => {
      if (!server.connected || at > server.received) return
      const samples = atob(pcm).length / 2
      server.received = Math.max(server.received, at + samples)
    },
    resume: () => server.connected ? server.resume() : Promise.reject(new ConnectionLostError('Not connected to server')),
    finish: () => server.connected ? server.onFinish() : Promise.reject(new ConnectionLostError('Not connected to server')),
    cancel: () => undefined,
    isConnected: () => server.connected,
    onConnect: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return { server, api }
}

/** A dictation under way, hearing, and the means to talk into it. */
async function talking(api: DictationApi) {
  const mic = fakeCapture()
  const dictation = await Dictation.begin(api, {}, { acquire: async () => mic.capture, replaceSilent: async () => undefined })
  /** Speak `blocks` blocks of 1600 samples, sent as they would be. */
  const say = async (blocks: number) => {
    for (let i = 0; i < blocks; i++) {
      mic.speak()
      await vi.advanceTimersByTimeAsync(100)
    }
  }
  return { dictation, say }
}

describe('Dictation through a dropped connection', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('sends, after a reconnect, everything the server lacks, from where it got to', async () => {
    const { server, api } = droppingServer()
    const { dictation, say } = await talking(api)
    await say(4)
    expect(server.received).toBe(4 * 1600)
    server.drop()
    await say(6)
    server.reconnect()
    await vi.advanceTimersByTimeAsync(0)
    expect(server.resumes).toBe(1)
    expect(server.received).toBe(10 * 1600)
    await say(2)
    await expect(dictation.finish()).resolves.toBe('words')
    expect(server.received).toBe(12 * 1600)
  })

  it('waits, when stopped while disconnected, for the connection to come back, then finishes', async () => {
    const { server, api } = droppingServer()
    const { dictation, say } = await talking(api)
    await say(3)
    server.drop()
    await say(2)
    const finished = dictation.finish()
    await vi.advanceTimersByTimeAsync(10_000)
    server.reconnect()
    await expect(finished).resolves.toBe('words')
    expect(server.received).toBe(5 * 1600)
  })

  it('gives up, saying why, when the connection does not come back within the grace', async () => {
    const { server, api } = droppingServer()
    const { dictation } = await talking(api)
    server.drop()
    const failed = expect(dictation.finish()).rejects.toThrow(CONNECTION_GONE)
    await vi.advanceTimersByTimeAsync(DICTATION_RESUME_GRACE_MS)
    await failed
  })

  it('asks again for a finish lost with the connection', async () => {
    const { server, api } = droppingServer()
    const { dictation, say } = await talking(api)
    await say(2)
    let asked = 0
    server.onFinish = () => {
      asked++
      if (asked > 1) return Promise.resolve('words')
      server.drop()
      return Promise.reject(new ConnectionLostError('Disconnected from server'))
    }
    const finished = dictation.finish()
    await vi.advanceTimersByTimeAsync(1000)
    server.reconnect()
    await expect(finished).resolves.toBe('words')
    expect(asked).toBe(2)
    expect(server.resumes).toBe(1)
  })

  it('fails with the server’s reason once the server has let the dictation go', async () => {
    const { server, api } = droppingServer()
    const { dictation } = await talking(api)
    server.drop()
    server.resume = () => Promise.reject(new Error('That dictation is no longer on the Mac'))
    const finished = dictation.finish()
    server.reconnect()
    await expect(finished).rejects.toThrow('no longer on the Mac')
  })
})
