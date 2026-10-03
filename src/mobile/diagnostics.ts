/**
 * Logging for a freeze: the screen stops updating while the page goes on
 * running (seen leaving the terminal view after a dictation in the composer —
 * the canvas kept panning, by the server's log, behind a frozen picture of
 * the terminal). Things to tell apart, each in the server's log:
 *
 * - `[focus]` — what holds the focus as it moves. A text box focused or
 *   removed while the keyboard comes and goes is the prime suspect.
 * - `[viewport]` — every change in the visible area, the keyboard's
 *   arrivals and departures among them (viewport.ts logs only arrivals).
 * - `[frames]` — the page's frames stopping while its timers still run: the
 *   web view no longer drawing, rather than the page hung. Logged when it
 *   starts and when it ends, if it ends.
 * - `[lifecycle]` — the page reloaded because iOS ended its process, as it
 *   does to a page using too much memory (the app counts them; see
 *   WebViewController's `webViewWebContentProcessDidTerminate`).
 */

declare global {
  interface Window { spacetermProcessRestarts?: number }
}

/** No frame for this long while the page is visible is a stall worth logging. */
const STALL_MS = 1000
const WATCH_MS = 250

function describe(el: Element | null): string {
  if (!el || el === document.body) return 'body'
  const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''
  return `${el.tagName.toLowerCase()}${cls}${el.isConnected ? '' : ' (detached)'}`
}

export function installDiagnostics(log: (message: string) => void): void {
  if (window.spacetermProcessRestarts) {
    log(`[lifecycle] reloaded because iOS ended the page's process (${window.spacetermProcessRestarts} this launch)`)
  }

  document.addEventListener('focusin', (e) => log(`[focus] in ${describe(e.target as Element)}`), true)
  document.addEventListener('focusout', (e) => {
    const target = e.target as Element
    // Read after the move, so a focus lost to nothing shows as `body`.
    queueMicrotask(() => log(`[focus] out ${describe(target)}, now ${describe(document.activeElement)}`))
  }, true)

  const vv = window.visualViewport
  if (vv) {
    let last = { height: Math.round(vv.height), top: Math.round(vv.offsetTop) }
    const changed = () => {
      const now = { height: Math.round(vv.height), top: Math.round(vv.offsetTop) }
      if (now.height === last.height && now.top === last.top) return
      log(`[viewport] visible ${last.height} → ${now.height} (top ${now.top}, innerHeight ${window.innerHeight}, focus ${describe(document.activeElement)})`)
      last = now
    }
    vv.addEventListener('resize', changed)
    vv.addEventListener('scroll', changed)
  }

  let lastFrame = performance.now()
  let stalledSince: number | null = null
  const frame = (t: number) => {
    lastFrame = t
    if (stalledSince !== null) {
      log(`[frames] resumed after ${Math.round(t - stalledSince)}ms without one`)
      stalledSince = null
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
  let lastTick = performance.now()
  setInterval(() => {
    const now = performance.now()
    const late = now - lastTick - WATCH_MS
    lastTick = now
    // A hidden page has no frames, and is meant not to.
    if (document.visibilityState !== 'visible') {
      lastFrame = now
      return
    }
    // The page itself was busy, which stops frames too: that is not the web view.
    if (late >= STALL_MS) {
      log(`[frames] the page was busy for ${Math.round(late)}ms`)
      lastFrame = now
      return
    }
    const gap = now - lastFrame
    if (gap < STALL_MS || stalledSince !== null) return
    stalledSince = lastFrame
    log(`[frames] none for ${Math.round(gap)}ms while timers run — the web view has stopped drawing (focus ${describe(document.activeElement)}, visible ${Math.round(vv?.height ?? 0)})`)
  }, WATCH_MS)
}
