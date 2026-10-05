import { useEffect, useRef } from 'react'

/** How long a press must last to be a long press. The phone's talk button uses the same. */
export const LONG_PRESS_MS = 450

/**
 * A button with two presses: a tap runs `onTap`, a press held for
 * `LONG_PRESS_MS` runs `onLongPress` as soon as it has lasted that long, and
 * the click that follows its release is swallowed. Pointer events, so the
 * same handlers serve a mouse and a finger; a keyboard activation is a tap.
 * Spread the result onto the button in place of `onClick`.
 */
export function useLongPress(onTap: () => void, onLongPress: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const longPressed = useRef(false)
  useEffect(() => () => clearTimeout(timer.current), [])
  const cancel = () => clearTimeout(timer.current)
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return
      longPressed.current = false
      cancel()
      timer.current = setTimeout(() => {
        longPressed.current = true
        onLongPress()
      }, LONG_PRESS_MS)
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    onClick: () => {
      if (longPressed.current) {
        longPressed.current = false
        return
      }
      onTap()
    },
  }
}
