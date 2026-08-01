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
