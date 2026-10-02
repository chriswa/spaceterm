import { useEffect } from 'react'

/**
 * Publish the visible area as CSS variables (`--m-vv-height`, `--m-vv-top`).
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
