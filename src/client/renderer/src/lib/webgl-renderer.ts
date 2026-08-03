import type { Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'

/**
 * Attach the WebGL renderer to a terminal; returns a disposer.
 *
 * xterm's default renderer builds a DOM node per styled run per row and lets
 * the browser lay them out. The WebGL renderer draws the whole grid from a
 * glyph atlas in one pass instead, which is several times faster on the
 * scroll-heavy output a TUI produces.
 *
 * This used to be a module that rationed a single WebGL context between many
 * terminals, on the assumption that every card held a live xterm and the
 * browser's 8–16 context limit was the binding constraint. That is not how the
 * app works: `TerminalCard` mounts an xterm only when the card is focused and
 * disposes it on unfocus, and every other card is a snapshot canvas painted
 * from the server's headless emulator. There is exactly one xterm at a time,
 * so there is nothing to ration — and the rationing indirection was itself the
 * reason the addon was never wired up to anything.
 *
 * On context loss the addon is disposed and xterm falls back to the DOM
 * renderer on its own; a lost context cannot be revived by re-adding it.
 */
/**
 * Can this environment actually give us a WebGL2 context?
 *
 * Loading the addon without checking is not safe to do speculatively: it does
 * not throw when context creation fails, it stores an undefined context and
 * then dies on the *next* theme change, several frames away from the cause.
 * Somewhere without WebGL — jsdom, software rendering, a blocklisted driver —
 * that reads as an unrelated crash while recolouring a card.
 */
function hasWebGL2(): boolean {
  try {
    const probe = document.createElement('canvas')
    const gl = probe.getContext('webgl2')
    if (!gl) return false
    // Hand the context back rather than waiting for GC; they are rationed.
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return true
  } catch {
    return false
  }
}

export function attachWebGLRenderer(terminal: Terminal): () => void {
  let addon: WebglAddon | null = null

  const dispose = () => {
    if (!addon) return
    const a = addon
    addon = null
    try {
      a.dispose()
    } catch {
      // Already disposed, or the context went away underneath us.
    }
  }

  // Say which renderer won, every time. The addon spent 210 commits wired to
  // nothing without anyone noticing, because a terminal on the slow renderer
  // looks exactly like a terminal on the fast one until you profile it.
  const report = (renderer: string) => {
    try {
      window.api?.log?.(`[TerminalRenderer] ${renderer}`)
    } catch {
      // Logging must never be the thing that breaks a terminal.
    }
  }

  if (!hasWebGL2()) {
    report('dom (no webgl2 context available)')
    return dispose
  }

  try {
    addon = new WebglAddon()
    addon.onContextLoss(dispose)
    terminal.loadAddon(addon)
    report('webgl')
  } catch {
    report('dom (webgl addon failed to load)')
    // Context creation lost a race with the probe — the DOM renderer is still
    // active, so there is nothing to undo.
    addon = null
  }

  return dispose
}
