import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The browser's microphone, faked: what matters is when a microphone is
 * opened and closed, and who hears its audio.
 */
function fakeBrowser(label: string) {
  const opened: Array<{ closed: boolean; label: string }> = []
  const nodes: Array<{ port: { onmessage: ((e: { data: Float32Array }) => void) | null } }> = []
  let currentLabel = label
  const deviceListeners: Array<() => void> = []
  const cues: string[] = []
  // Cues play through an audio context of their own, so a microphone counts
  // as opened when a stream is wired in, not when a context is made.
  class FakeContext {
    state = 'running'
    sampleRate = 48_000
    destination = {}
    audioWorklet = { addModule: async () => undefined }
    record = { closed: false, label: currentLabel }
    resume() { return Promise.resolve() }
    close() { this.state = 'closed'; this.record.closed = true; return Promise.resolve() }
    createMediaStreamSource() { opened.push(this.record); return { connect: () => undefined } }
    createBuffer() { return { copyToChannel: () => undefined } }
    createGain() { return { gain: { value: 0 }, connect: (next: unknown) => next } }
    createBufferSource() { return { buffer: null, connect: (next: unknown) => next, start: () => undefined } }
  }
  ;(window as unknown as { api: unknown }).api = {
    log: (message: string) => { const cue = /^\[cue\] (\w+)/.exec(message); if (cue) cues.push(cue[1]) },
  }
  class FakeNode {
    port = { onmessage: null as ((e: { data: Float32Array }) => void) | null }
    constructor() { nodes.push(this) }
    disconnect() { /* nothing to undo */ }
  }
  vi.stubGlobal('AudioContext', FakeContext)
  vi.stubGlobal('AudioWorkletNode', FakeNode)
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      addEventListener: (type: string, fn: () => void) => { if (type === 'devicechange') deviceListeners.push(fn) },
      getUserMedia: async () => {
        const track = { label: currentLabel, readyState: 'live', stop() { this.readyState = 'ended' } }
        return { getAudioTracks: () => [track], getTracks: () => [track] }
      },
    },
  })
  URL.createObjectURL = () => 'blob:tap'
  URL.revokeObjectURL = () => undefined
  return {
    opened,
    /** Cues played, in order. */
    cues,
    /** Audio from the most recently opened microphone. */
    speak: (samples: number[]) => nodes.at(-1)!.port.onmessage?.({ data: Float32Array.from(samples) }),
    useMicrophone: (next: string) => { currentLabel = next },
    deviceChanged: () => deviceListeners.forEach((fn) => fn()),
  }
}

async function load() {
  vi.resetModules()
  return import('./held-microphone')
}

beforeEach(() => localStorage.clear())
afterEach(() => vi.unstubAllGlobals())

describe('isHeadset', () => {
  it('tells a headset from the phone', async () => {
    const { isHeadset } = await load()
    expect(isHeadset('AirPods Pro')).toBe(true)
    expect(isHeadset('Chris’s Beats Studio')).toBe(true)
    expect(isHeadset('iPhone Microphone')).toBe(false)
  })
})

describe('held microphone', () => {
  it('holds a headset open between dictations, and every dictation hears it', async () => {
    const browser = fakeBrowser('AirPods Pro')
    const held = await load()
    held.setHoldMicrophone(true)
    const first = await held.acquire()
    const heard: number[] = []
    const stop = first.listen((block) => heard.push(...block))
    browser.speak([0.1])
    stop()
    first.release()
    browser.speak([0.2])
    const second = await held.acquire()
    expect(second).toBe(first)
    second.listen((block) => heard.push(...block))
    browser.speak([0.3])
    // Opened once, still open; audio between dictations went nowhere.
    expect(browser.opened).toHaveLength(1)
    expect(browser.opened[0].closed).toBe(false)
    expect(heard.map((n) => Math.round(n * 10) / 10)).toEqual([0.1, 0.3])
  })

  it('does not hold the phone’s own microphone, which would play through the earpiece', async () => {
    const browser = fakeBrowser('iPhone Microphone')
    const held = await load()
    held.setHoldMicrophone(true)
    const capture = await held.acquire()
    capture.release()
    expect(browser.opened.every((mic) => mic.closed)).toBe(true)
  })

  it('closes a held microphone that went silent, and opens afresh next time', async () => {
    const browser = fakeBrowser('AirPods Pro')
    const held = await load()
    held.setHoldMicrophone(true)
    const capture = await held.acquire()
    capture.release(true)
    expect(browser.opened[0].closed).toBe(true)
    const next = await held.acquire()
    expect(next).not.toBe(capture)
    expect(browser.opened).toHaveLength(2)
  })

  it('closes when turned off', async () => {
    const browser = fakeBrowser('AirPods Pro')
    const held = await load()
    held.setHoldMicrophone(true)
    ;(await held.acquire()).release()
    held.setHoldMicrophone(false)
    expect(browser.opened.every((mic) => mic.closed)).toBe(true)
    expect(held.holdsMicrophone()).toBe(false)
  })

  it('starts off at every launch, however it was left', async () => {
    fakeBrowser('AirPods Pro')
    let held = await load()
    held.setHoldMicrophone(true)
    held = await load()
    expect(held.holdsMicrophone()).toBe(false)
    expect(held.holdState()).toBe('off')
  })

  it('with holding off, every dictation opens and closes its own microphone', async () => {
    const browser = fakeBrowser('AirPods Pro')
    const held = await load()
    const capture = await held.acquire()
    capture.release()
    expect(browser.opened).toHaveLength(1)
    expect(browser.opened[0].closed).toBe(true)
  })
})

describe('bringing the hold back', () => {
  const pointer = (type: string, id: number, x = 10, y = 10) =>
    document.dispatchEvent(Object.assign(new Event(type), { pointerId: id, clientX: x, clientY: y }))
  const tap = () => { pointer('pointerdown', 1); pointer('pointerup', 1) }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  let uninstall: (() => void) | undefined
  afterEach(() => { uninstall?.(); uninstall = undefined })

  /** Holding, then the microphone lost — as iOS takes it in the background. */
  async function heldThenLost(held: Awaited<ReturnType<typeof load>>) {
    held.setHoldMicrophone(true)
    ;(await held.acquire()).release(true)
  }

  it('reopens on a tap, never during a pinch or a pan', async () => {
    const browser = fakeBrowser('AirPods Pro')
    const held = await load()
    await heldThenLost(held)
    uninstall = held.installHeldMicrophone()
    pointer('pointerdown', 1); pointer('pointerdown', 2); pointer('pointerup', 1); pointer('pointerup', 2)
    pointer('pointerdown', 3); pointer('pointerup', 3, 200, 10)
    await settle()
    expect(browser.opened).toHaveLength(1)
    tap()
    await settle()
    expect(browser.opened).toHaveLength(2)
    expect(browser.opened[1].closed).toBe(false)
  })

  it('tries the phone\'s own microphone once, then waits for a device to change', async () => {
    const browser = fakeBrowser('iPhone Microphone')
    const held = await load()
    await heldThenLost(held)
    uninstall = held.installHeldMicrophone()
    tap(); await settle()
    tap(); await settle()
    tap(); await settle()
    expect(browser.opened).toHaveLength(2)
    browser.useMicrophone('AirPods Pro')
    browser.deviceChanged()
    tap(); await settle()
    expect(browser.opened).toHaveLength(3)
    expect(browser.opened[2].closed).toBe(false)
  })
})

describe('the hold, as the button and the ear know it', () => {
  it('prepares, sounds when it takes the microphone, and sounds again when it lets go', async () => {
    const browser = fakeBrowser('AirPods Pro')
    const held = await load()
    const states: string[] = []
    held.onHoldStateChange((state) => states.push(state))
    expect(held.holdState()).toBe('off')
    held.setHoldMicrophone(true)
    expect(held.holdState()).toBe('preparing')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(held.holdState()).toBe('held')
    held.setHoldMicrophone(false)
    expect(states).toEqual(['preparing', 'held', 'off'])
    expect(browser.cues).toEqual(['holdEngaged', 'holdReleased'])
  })

  it('stays preparing, and silent, without a headset to hold', async () => {
    const browser = fakeBrowser('iPhone Microphone')
    const held = await load()
    held.setHoldMicrophone(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(held.holdState()).toBe('preparing')
    held.setHoldMicrophone(false)
    expect(browser.cues).toEqual([])
  })
})
