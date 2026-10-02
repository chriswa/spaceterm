import { useEffect } from 'react'

/** Below this, a shrunk visible area is browser chrome, not a keyboard. */
const KEYBOARD_MIN_PX = 120
/**
 * An iPhone's portrait keyboard with its suggestion bar, until one has been
 * measured. Erring tall: a bar a little high stays put when the keyboard
 * arrives, where one too low jumps.
 */
const DEFAULT_KEYBOARD_PX = 360
const KEYBOARD_KEY = 'mobile.keyboardHeight'

function rememberedKeyboard(): number {
  try {
    const v = Number(localStorage.getItem(KEYBOARD_KEY))
    return v >= KEYBOARD_MIN_PX ? v : DEFAULT_KEYBOARD_PX
  } catch {
    return DEFAULT_KEYBOARD_PX
  }
}

function rememberKeyboard(px: number): void {
  try { localStorage.setItem(KEYBOARD_KEY, String(Math.round(px))) } catch { /* private mode */ }
}

/**
 * Publish the visible area as CSS variables:
 *
 * - `--m-vv-height`, `--m-vv-top` — the visible area, which on iOS shrinks for
 *   the keyboard while `position: fixed; inset: 0` keeps the full height, so a
 *   panel sized that way has its bottom behind the keyboard.
 * - `--m-above-keyboard` — the height of everything above the keyboard,
 *   whether or not it is up: the visible area while it is, and the full height
 *   less its remembered size while it is not. A panel sized to this keeps its
 *   bottom edge still as the keyboard comes and goes (the composer's buttons).
 *
 * The keyboard is measured as the shortfall from the tallest the visible area
 * has been since the last rotation — not from `innerHeight`, which an embedded
 * web view may shrink along with it.
 */
export function useVisualViewportVars(): void {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    let full = vv.height
    let width = vv.width
    let lastLogged = 0

    const update = () => {
      // A rotation changes what "full" means.
      if (vv.width !== width) {
        width = vv.width
        full = vv.height
      }
      full = Math.max(full, vv.height)
      const shortfall = full - vv.height
      const keyboardUp = shortfall >= KEYBOARD_MIN_PX
      if (keyboardUp) {
        rememberKeyboard(shortfall)
        if (Math.abs(shortfall - lastLogged) > 4) {
          lastLogged = shortfall
          window.api?.log(`[viewport] keyboard ${Math.round(shortfall)}px (visible ${Math.round(vv.height)} of ${Math.round(full)}, innerHeight ${window.innerHeight})`)
        }
      }
      root.style.setProperty('--m-vv-height', `${vv.height}px`)
      root.style.setProperty('--m-vv-top', `${vv.offsetTop}px`)
      root.style.setProperty('--m-above-keyboard', `${keyboardUp ? vv.height : full - rememberedKeyboard()}px`)
    }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])
}
