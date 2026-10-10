import { useEffect } from 'react'
import { TerminalGesture } from './terminal-gesture'

/**
 * A one-finger sideways drag dismisses the screen it starts on — Control's
 * transcript, or the toolbar sheet — as the same drag leaves the terminal
 * view: the same classifier (`TerminalGesture`), so sideways has to beat
 * vertical just as hard, and a scroll is never taken for a dismissal.
 *
 * A drag that starts on something that moves sideways itself is its own: the
 * sheet's button strip scrolls horizontally, a row's handle reorders, and the
 * transcript's text box moves its caret.
 */

/** A screen a sideways drag can dismiss, and how. */
export interface SwipeScreen {
  /** The screen's element; a drag must start inside it. */
  selector: string
  /** Where a drag is not the screen's to take. */
  ignore?: string
  dismiss(): void
}

export const SWIPE_SCREENS = {
  transcript: { selector: '.control-transcript--screen', ignore: 'textarea, input' },
  sheet: { selector: '.toolbar-sheet__panel', ignore: '.toolbar__strip, .toolbar__crab-row-handle, .toolbar__menu' },
} as const

/** The screen a touch starting on `target` would dismiss, if any. */
export function swipeScreenAt(target: EventTarget | null, screens: readonly SwipeScreen[]): SwipeScreen | undefined {
  if (!(target instanceof Element)) return undefined
  return screens.find((screen) => target.closest(screen.selector) && !(screen.ignore && target.closest(screen.ignore)))
}

/** Watches the whole page for a sideways drag over one of `screens` (the ones open now). */
export function useSwipeToDismiss(screens: readonly SwipeScreen[]): void {
  useEffect(() => {
    if (!screens.length) return
    const gesture = new TerminalGesture()
    let screen: SwipeScreen | undefined

    const leave = () => {
      const leaving = screen
      screen = undefined
      leaving?.dismiss()
    }
    const onStart = (e: TouchEvent) => {
      // One finger only: a second one ends it.
      screen = e.touches.length === 1 ? swipeScreenAt(e.target, screens) : undefined
      if (screen) gesture.begin(e.touches[0].clientX, e.touches[0].clientY, e.timeStamp)
    }
    const onMove = (e: TouchEvent) => {
      if (!screen) return
      if (e.touches.length !== 1) { screen = undefined; return }
      if (gesture.move(e.touches[0].clientX, e.touches[0].clientY).kind === 'exit') leave()
    }
    const onEnd = (e: TouchEvent) => {
      if (!screen) return
      // A quick flick that fell short of the distance still counts, on release.
      if (gesture.end(e.timeStamp) === 'exit') leave()
      screen = undefined
    }
    // Taken from us — never a dismissal.
    const onCancel = () => { screen = undefined }

    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchmove', onMove, { passive: true })
    document.addEventListener('touchend', onEnd, { passive: true })
    document.addEventListener('touchcancel', onCancel, { passive: true })
    return () => {
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onEnd)
      document.removeEventListener('touchcancel', onCancel)
    }
  }, [screens])
}
