import { useEffect, useLayoutEffect, useRef, type MouseEvent, type RefObject } from 'react'
import { shiftIntoView } from '../lib/floating-layout'

/**
 * What every menu that opens where it was asked for — the quick-actions bar,
 * the add-node menu — needs, opened by a ⌘-click or a long press:
 *
 * - **Whole on screen.** Centred on the press, then moved in from any edge it
 *   crosses, measured as drawn (the phone enlarges menus with CSS `scale`)
 *   and before the first paint, so it never visibly jumps. `arrange` runs
 *   first, for a menu that lays itself out by its width.
 * - **Gone when attention moves on**: a press outside it, a scroll or zoom,
 *   Escape.
 * - **Not chosen by the press that opened it.** The menu appears under the
 *   finger, and lifting it makes a click there that iOS does not reliably let
 *   be cancelled; until a new touch begins, every click is that one, and is
 *   swallowed. Mouse-opened menus take the first click.
 *
 * Returns the click-capture handler for the menu's root.
 */
export function usePressPopup(
  ref: RefObject<HTMLElement | null>,
  at: { screenX: number; screenY: number; openedByTouch?: boolean; onDismiss: () => void },
  arrange?: (el: HTMLElement) => void
): (e: MouseEvent) => void {
  const { screenX, screenY, openedByTouch = false, onDismiss } = at

  useEffect(() => {
    const outside = (e: globalThis.MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismiss()
    }
    const scrolled = () => onDismiss()
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onDismiss()
    }
    document.addEventListener('mousedown', outside, { capture: true })
    window.addEventListener('wheel', scrolled, { capture: true, passive: true })
    window.addEventListener('keydown', key, { capture: true })
    return () => {
      document.removeEventListener('mousedown', outside, { capture: true })
      window.removeEventListener('wheel', scrolled, { capture: true })
      window.removeEventListener('keydown', key, { capture: true })
    }
  }, [ref, onDismiss])

  const arrangeRef = useRef(arrange)
  arrangeRef.current = arrange
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.left = `${screenX}px`
    el.style.top = `${screenY}px`
    arrangeRef.current?.(el)
    const box = el.getBoundingClientRect()
    el.style.left = `${screenX + shiftIntoView(box.left, box.right, window.innerWidth)}px`
    el.style.top = `${screenY + shiftIntoView(box.top, box.bottom, window.innerHeight)}px`
  }, [ref, screenX, screenY])

  const armedRef = useRef(!openedByTouch)
  useEffect(() => {
    if (armedRef.current) return
    const arm = () => { armedRef.current = true }
    window.addEventListener('touchstart', arm, { capture: true, passive: true })
    return () => window.removeEventListener('touchstart', arm, { capture: true })
  }, [])

  return (e: MouseEvent) => {
    if (armedRef.current) return
    e.preventDefault()
    e.stopPropagation()
  }
}
