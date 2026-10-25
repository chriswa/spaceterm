import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { DictationApi } from '../shared/api'
import type { Capture } from './held-microphone'
import { AudioStats, Dictation, NO_AUDIO_TIMEOUT_MS, whenHearing } from './dictation'

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
