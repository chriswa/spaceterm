import { useEffect, useRef, type ReactNode } from 'react'
import { blockingUpdate, useUpdateActionsStore, type UpdateKind } from '../stores/updateActionsStore'

export const BLOCKER_TEXT: Record<UpdateKind, { title: string; detail?: string }> = {
  install: {
    title: 'Please wait for the iOS app update',
    detail: 'The app will be closed and restarted automatically.',
  },
  restart: {
    title: 'Restarting the server',
    detail: 'Spaceterm comes back by itself once the server is up again.',
  },
  reload: { title: 'Reloading…' },
}

/**
 * A screen over everything while a restart, an install or a reload is under
 * way (updateActionsStore.ts), with no way to dismiss it: anything done in
 * the meantime would be lost, or sent to a server on its way down.
 *
 * It goes only with the page — the desktop exits once the server has taken
 * the restart, and the phone reloads once the new server answers
 * (install-api.ts), so it waits through the server being down — or when the
 * action fails, which says so in a toast.
 *
 * A modal `<dialog>`, so that it is drawn in the browser's top layer, over
 * everything whatever its z-index. As a z-index of its own it lost: the
 * phone's toolbar sheet, where its ↻ is pressed, and its bottom bar sit near
 * the largest z-index there is, so the screen came up hidden behind them.
 */
export function UpdateBlocker() {
  const kind = useUpdateActionsStore((s) => blockingUpdate(s.running))
  useEffect(() => (kind ? swallowInput() : undefined), [kind])
  if (!kind) return null
  const { title, detail } = BLOCKER_TEXT[kind]
  return (
    <TopLayer kind={kind}>
      <div className="update-blocker__box">
        <div className="update-blocker__spinner" aria-hidden="true" />
        <div id="update-blocker-title" className="update-blocker__title">{title}</div>
        {detail && <div className="update-blocker__detail">{detail}</div>}
      </div>
    </TopLayer>
  )
}

function TopLayer({ kind, children }: { kind: UpdateKind; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog || dialog.open) return
    // jsdom has no showModal; there it is only shown.
    if (typeof dialog.showModal === 'function') dialog.showModal()
    else dialog.setAttribute('open', '')
  }, [])
  return (
    <dialog
      ref={ref}
      className="update-blocker"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="update-blocker-title"
      data-kind={kind}
      // Escape would close a modal dialog: this one goes only with the page.
      onCancel={(e) => e.preventDefault()}
    >
      {children}
    </dialog>
  )
}

/**
 * The screen takes the pointer, but keys go to whatever had focus — a
 * terminal, the composer — and the canvas listens on the window too. Stopped
 * at the window, before anything else hears them.
 */
const SWALLOWED = ['keydown', 'keypress', 'keyup', 'paste', 'wheel', 'pointerdown', 'touchstart', 'mousedown', 'contextmenu'] as const

function swallowInput(): () => void {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  const stop = (e: Event) => {
    e.stopPropagation()
    if (e.cancelable && e.type !== 'touchstart' && e.type !== 'pointerdown') e.preventDefault()
  }
  SWALLOWED.forEach((type) => window.addEventListener(type, stop, { capture: true, passive: false }))
  return () => SWALLOWED.forEach((type) => window.removeEventListener(type, stop, { capture: true }))
}
