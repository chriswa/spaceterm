import { describe, it, expect, afterEach } from 'vitest'
import {
  installSupersample,
  isSupersampleActive,
  realDevicePixelRatio,
  resetSupersampleForTest,
  shouldSupersample,
} from './supersample'

type FakeWindow = Window & typeof globalThis & {
  /** Move the window to a display with this ratio, firing the armed query. */
  moveTo(ratio: number): void
}

/**
 * A stand-in window whose ratio is an accessor, as on Chromium's global, with a
 * `matchMedia` that fires `change` on the query armed for the old ratio.
 */
function fakeWindow(initial: number, extra: object = {}): FakeWindow {
  let ratio = initial
  let listeners: (() => void)[] = []
  const win = {
    matchMedia: () => ({
      addEventListener: (_: string, listener: () => void) => { listeners.push(listener) },
    }),
    moveTo(next: number) {
      ratio = next
      const fire = listeners
      listeners = []
      for (const l of fire) l()
    },
    ...extra,
  }
  Object.defineProperty(win, 'devicePixelRatio', { get: () => ratio, configurable: true })
  return win as unknown as FakeWindow
}

afterEach(resetSupersampleForTest)

describe('shouldSupersample', () => {
  it('supersamples a 1× display and not a Retina one', () => {
    expect(shouldSupersample(1)).toBe(true)
    expect(shouldSupersample(2)).toBe(false)
  })
})

describe('installSupersample', () => {
  it('leaves the ratio untouched when it does not apply', () => {
    const win = fakeWindow(2)
    const before = Object.getOwnPropertyDescriptor(win, 'devicePixelRatio')
    installSupersample({ win })
    expect(Object.getOwnPropertyDescriptor(win, 'devicePixelRatio')).toEqual(before)
    expect(isSupersampleActive()).toBe(false)
  })

  it('doubles the ratio on a 1× display, and keeps the real one readable', () => {
    const win = fakeWindow(1)
    installSupersample({ win })
    expect(win.devicePixelRatio).toBe(2)
    expect(realDevicePixelRatio()).toBe(1)
    expect(isSupersampleActive()).toBe(true)
  })

  it('installs once, so a second call does not compound', () => {
    const win = fakeWindow(1)
    installSupersample({ win })
    installSupersample({ win })
    expect(win.devicePixelRatio).toBe(2)
  })
})

describe('following the display', () => {
  function install(initial: number) {
    const win = fakeWindow(initial)
    let reloads = 0
    installSupersample({ win, reload: () => { reloads++ } })
    return { win, reloads: () => reloads }
  }

  it('reloads when the window moves from the laptop to a 1× monitor and back', () => {
    const fromLaptop = install(2)
    fromLaptop.win.moveTo(1)
    expect(fromLaptop.reloads()).toBe(1)

    resetSupersampleForTest()
    const fromMonitor = install(1)
    fromMonitor.win.moveTo(2)
    expect(fromMonitor.reloads()).toBe(1)
  })

  it('does not reload for a move that keeps the same answer, and keeps watching after it', () => {
    const { win, reloads } = install(2)
    win.moveTo(3)
    expect(reloads()).toBe(0)
    win.moveTo(1)
    expect(reloads()).toBe(1)
  })
})

describe('the ResizeObserver wrapper', () => {
  type Callback = (entries: ResizeObserverEntry[], observer: unknown) => void
  /** Records the callback so a test can fire entries at it. */
  class FakeObserver {
    static last: Callback
    constructor(callback: Callback) { FakeObserver.last = callback }
  }

  function entry(device: { inlineSize: number; blockSize: number } | undefined, target = {}) {
    return { target, contentRect: { width: 640 }, ...(device ? { devicePixelContentBoxSize: [device] } : {}) }
  }

  function observe(e: object): ResizeObserverEntry {
    const win = fakeWindow(1, { ResizeObserver: FakeObserver })
    installSupersample({ win })
    let seen: ResizeObserverEntry[] = []
    new win.ResizeObserver(entries => { seen = entries })
    FakeObserver.last([e as ResizeObserverEntry], null)
    return seen[0]
  }

  it('scales device-pixel sizes to the overridden ratio, leaving the rest alone', () => {
    const target = {}
    const seen = observe(entry({ inlineSize: 1280, blockSize: 720 }, target))
    expect(seen.devicePixelContentBoxSize[0]).toEqual({ inlineSize: 2560, blockSize: 1440 })
    expect('devicePixelContentBoxSize' in seen).toBe(true)
    expect(seen.target).toBe(target)
    expect(seen.contentRect.width).toBe(640)
  })

  it('passes entries without device-pixel sizes through', () => {
    const e = entry(undefined)
    expect(observe(e)).toBe(e)
  })

  it('is not installed when supersampling does not apply', () => {
    const win = fakeWindow(2, { ResizeObserver: FakeObserver })
    installSupersample({ win })
    expect(win.ResizeObserver).toBe(FakeObserver)
  })
})
