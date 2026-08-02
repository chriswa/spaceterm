import { useCallback, useEffect, useRef, useState } from 'react'

export interface ToolbarMenu {
  open: boolean
  toggle: () => void
  close: () => void
  /** Attach to the element wrapping both the trigger and the menu. */
  ref: React.RefObject<HTMLDivElement>
}

/**
 * Open/close state for a toolbar pull-up menu, with dismissal handled.
 *
 * Three widgets now have one of these (debug tools, font theme, canvas theme)
 * and each had grown its own copy of the same `useEffect` — a `mousedown`
 * listener, a `contains` check, and a cleanup that had to be kept in step with
 * an `open` dependency. One of the copies is enough to maintain, and pulling
 * it out is what made adding Escape-to-close a one-line change for all three
 * rather than three chances to forget.
 *
 * The trigger must sit inside `ref`'s element: the outside-click handler works
 * by containment, so a trigger outside it would close the menu on the same
 * click that opened it.
 */
export function useToolbarMenu(): ToolbarMenu {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const toggle = useCallback(() => setOpen(o => !o), [])
  const close = useCallback(() => setOpen(false), [])

  return { open, toggle, close, ref }
}
