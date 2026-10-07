/**
 * "2× supersample": make the renderer draw at twice the display's real pixel
 * ratio, so on a 1× monitor every canvas and xterm's WebGL renderer render at
 * 2× backing resolution and Chromium downsamples the result.
 *
 * Done once, by overriding `window.devicePixelRatio` before anything reads it,
 * rather than at each call site — xterm reads it internally, where no call site
 * can reach. Nothing re-measures when the override changes (no `resolution`
 * media query fires), so the setting only takes effect on a reload.
 *
 * The real ratio also leaks through `ResizeObserver`'s
 * `devicePixelContentBoxSize`, which xterm's WebGL addon uses to snap its
 * canvas to the exact device size — undoing the override a frame later. So the
 * observer is wrapped to scale those entries by the same factor.
 *
 * It applies only on a 1× display: a Retina panel gains little from it and
 * pays four times the fragment work. The page's real ratio is the display's
 * scale factor, so no help from the main process is needed to tell them apart.
 * When the window moves to a display that wants the other answer, the page
 * reloads, since nothing can be re-measured in place.
 */

const FACTOR = 2

let realGetter: (() => number) | null = null
let active = false

/** Whether a display with this real pixel ratio gets supersampled. */
export function shouldSupersample(realRatio: number): boolean {
  // A tolerance rather than `=== 1`: the ratio is a float, and browser zoom
  // can nudge it off a whole number.
  return realRatio < 1.5
}

/** The display's own pixel ratio, ignoring the override. */
export function realDevicePixelRatio(): number {
  return realGetter ? realGetter() : window.devicePixelRatio
}

/** Whether this page was loaded supersampled. */
export function isSupersampleActive(): boolean {
  return active
}

interface InstallOptions {
  win?: Window & typeof globalThis
  reload?: () => void
}

/**
 * Install the override when this display calls for it. Must run before xterm
 * or any canvas code reads the ratio. When it does not apply,
 * `devicePixelRatio` and `ResizeObserver` are left untouched, so a page that is
 * not supersampled is exactly the unmodified page.
 */
export function installSupersample({
  win = window,
  reload = () => win.location.reload(),
}: InstallOptions = {}): void {
  if (realGetter) return
  // Chromium defines the attribute on the global object itself; the prototype
  // chain is the fallback for engines that put it on Window.prototype.
  const descriptor = Object.getOwnPropertyDescriptor(win, 'devicePixelRatio')
    ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(win), 'devicePixelRatio')
  const original = descriptor?.get
  const value = descriptor?.value as number | undefined
  const real = original ? () => original.call(win) as number : () => value ?? 1
  realGetter = real

  active = shouldSupersample(real())
  if (active) {
    Object.defineProperty(win, 'devicePixelRatio', {
      get: () => real() * FACTOR,
      configurable: true,
    })
    if (typeof win.ResizeObserver === 'function') win.ResizeObserver = scaledResizeObserver(win.ResizeObserver)
  }

  watchRealRatio(win, real, ratio => {
    if (shouldSupersample(ratio) !== active) reload()
  })
}

/**
 * Call `onChange` with the new ratio whenever the window lands on a display
 * with a different one. A media query is built around the *real* ratio — CSS
 * resolution ignores the JS override — and re-armed after each change.
 */
function watchRealRatio(win: Window, real: () => number, onChange: (ratio: number) => void): void {
  const arm = (): void => {
    let query: MediaQueryList
    try {
      query = win.matchMedia(`(resolution: ${real()}dppx)`)
    } catch {
      // jsdom and older engines parse `resolution` queries poorly; losing the
      // follow-the-display behaviour is not worth breaking startup over.
      return
    }
    query.addEventListener('change', () => {
      onChange(real())
      arm()
    }, { once: true })
  }
  arm()
}

/** A ResizeObserver whose device-pixel sizes agree with the overridden ratio. */
function scaledResizeObserver(Real: typeof ResizeObserver): typeof ResizeObserver {
  return class extends Real {
    constructor(callback: ResizeObserverCallback) {
      super((entries, observer) => callback(entries.map(scaleEntry), observer))
    }
  }
}

function scaleEntry(entry: ResizeObserverEntry): ResizeObserverEntry {
  const sizes = entry.devicePixelContentBoxSize
  if (!sizes) return entry
  const scaled = Array.from(sizes, s => ({ inlineSize: s.inlineSize * FACTOR, blockSize: s.blockSize * FACTOR }))
  return new Proxy(entry, {
    get: (target, key) => key === 'devicePixelContentBoxSize' ? scaled : Reflect.get(target, key, target),
  })
}

/** For tests: forget what was installed. Does not undo the override. */
export function resetSupersampleForTest(): void {
  realGetter = null
  active = false
}
