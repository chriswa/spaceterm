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
  class FakeContext {
    state = 'running'
    sampleRate = 48_000
    audioWorklet = { addModule: async () => undefined }
    record = { closed: false, label: currentLabel }
    constructor() { opened.push(this.record) }
    resume() { return Promise.resolve() }
    close() { this.state = 'closed'; this.record.closed = true; return Promise.resolve() }
    createMediaStreamSource() { return { connect: () => undefined } }
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

  it('closes when turned off, and remembers the setting on this phone', async () => {
    const browser = fakeBrowser('AirPods Pro')
    let held = await load()
    held.setHoldMicrophone(true)
    ;(await held.acquire()).release()
    held.setHoldMicrophone(false)
    expect(browser.opened.every((mic) => mic.closed)).toBe(true)
    held = await load()
    expect(held.holdsMicrophone()).toBe(false)
    held.setHoldMicrophone(true)
    held = await load()
    expect(held.holdsMicrophone()).toBe(true)
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

  it('reopens on a tap, never during a pinch or a pan', async () => {
    const browser = fakeBrowser('AirPods Pro')
    localStorage.setItem('mobile.holdMicrophone', '1')
    const held = await load()
    uninstall = held.installHeldMicrophone()
    pointer('pointerdown', 1); pointer('pointerdown', 2); pointer('pointerup', 1); pointer('pointerup', 2)
    pointer('pointerdown', 3); pointer('pointerup', 3, 200, 10)
    await settle()
    expect(browser.opened).toHaveLength(0)
    tap()
    await settle()
    expect(browser.opened).toHaveLength(1)
    expect(browser.opened[0].closed).toBe(false)
  })

  it('tries the phone\'s own microphone once, then waits for a device to change', async () => {
    const browser = fakeBrowser('iPhone Microphone')
    localStorage.setItem('mobile.holdMicrophone', '1')
    const held = await load()
    uninstall = held.installHeldMicrophone()
    tap(); await settle()
    tap(); await settle()
    tap(); await settle()
    expect(browser.opened).toHaveLength(1)
    browser.useMicrophone('AirPods Pro')
    browser.deviceChanged()
    tap(); await settle()
    expect(browser.opened).toHaveLength(2)
    expect(browser.opened[1].closed).toBe(false)
  })
})
