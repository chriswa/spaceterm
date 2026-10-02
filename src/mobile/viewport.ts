import { useEffect } from 'react'

/** Below this, a shrunk visual viewport is browser chrome, not a keyboard. */
const KEYBOARD_MIN_PX = 120
/** An iPhone's portrait keyboard with its suggestion bar, until one has been measured. */
const DEFAULT_KEYBOARD_PX = 336
const KEYBOARD_KEY = 'mobile.keyboardHeight'

/**
 * The keyboard's height: measured while it is up, and remembered for when it
 * is not, so a view can keep its space free either way (`--m-kb-height`).
 */
function keyboardHeight(covered: number): number {
  try {
    if (covered >= KEYBOARD_MIN_PX) {
      localStorage.setItem(KEYBOARD_KEY, String(Math.round(covered)))
      return covered
    }
    const remembered = Number(localStorage.getItem(KEYBOARD_KEY))
    return remembered >= KEYBOARD_MIN_PX ? remembered : DEFAULT_KEYBOARD_PX
  } catch {
    return covered >= KEYBOARD_MIN_PX ? covered : DEFAULT_KEYBOARD_PX
  }
}

/**
 * Publish the visible area as CSS variables (`--m-vv-height`, `--m-vv-top`),
 * with the layout height and the keyboard's (`--m-layout-height`, `--m-kb-height`).
 *
 * On iOS the on-screen keyboard shrinks the *visual* viewport while
 * `position: fixed; inset: 0` keeps the full layout viewport, so a fixed
 * panel sized that way has its bottom hidden behind the keyboard. Panels that
 * must stay above it — the terminal with its key row, the composer — size to
 * these instead.
 */
export function useVisualViewportVars(): void {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    const update = () => {
      root.style.setProperty('--m-vv-height', `${vv.height}px`)
      root.style.setProperty('--m-vv-top', `${vv.offsetTop}px`)
      root.style.setProperty('--m-layout-height', `${window.innerHeight}px`)
      root.style.setProperty('--m-kb-height', `${keyboardHeight(window.innerHeight - vv.height)}px`)
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
