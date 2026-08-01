/**
 * Browser APIs jsdom does not implement, stubbed just enough to import the
 * renderer.
 *
 * Every one of these is here because a real module reaches for it. The stubs
 * are deliberately dumb: a test that cares about audio or layout should assert
 * against the fake bridge or against the DOM, not against these. Their only job
 * is to stop an import from throwing.
 *
 * Loaded by the `renderer` vitest project's `setupFiles`.
 */

class StubAudioContext {
  currentTime = 0
  destination = {}
  createOscillator(): unknown {
    return {
      type: 'sine', frequency: { value: 0 },
      connect: () => {}, start: () => {}, stop: () => {},
      addEventListener: () => {}, onended: null
    }
  }
  createGain(): unknown {
    return {
      gain: {
        value: 0,
        setValueAtTime: () => {},
        linearRampToValueAtTime: () => {},
        exponentialRampToValueAtTime: () => {}
      },
      connect: () => {}
    }
  }
  createBufferSource(): unknown {
    return { buffer: null, connect: () => {}, start: () => {}, stop: () => {} }
  }
  decodeAudioData(): Promise<unknown> { return Promise.resolve({}) }
  resume(): Promise<void> { return Promise.resolve() }
  close(): Promise<void> { return Promise.resolve() }
}

/** Observers the renderer registers but never depends on for correctness. */
class StubObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function define(name: string, value: unknown): void {
  if (name in globalThis) return
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
}

/**
 * jsdom has no 2D canvas, and xterm asks for one during measurement.
 *
 * It falls back to DOM rendering without it, so the only cost of the missing
 * API is a "Not implemented" line printed on every terminal test. A stub that
 * returns null lets xterm take its own fallback path quietly, which is the same
 * path it takes in a browser where canvas is unavailable.
 */
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (() => null) as never
}

define('AudioContext', StubAudioContext)
define('webkitAudioContext', StubAudioContext)
define('ResizeObserver', StubObserver)
define('IntersectionObserver', StubObserver)
define('MutationObserver', StubObserver)

// jsdom implements neither, and xterm asks for both during measurement.
if (typeof globalThis.matchMedia !== 'function') {
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false
    })
  })
}

if (typeof globalThis.requestAnimationFrame !== 'function') {
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    writable: true,
    value: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number
  })
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    writable: true,
    value: (handle: number) => clearTimeout(handle as unknown as NodeJS.Timeout)
  })
}
