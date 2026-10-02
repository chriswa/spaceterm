import { useEffect, useRef, useState } from 'react'
import { App } from '@/App'
import { useSurfacePresenterStore } from '@/stores/surfacePresenterStore'
import { useNodeStore } from '@/stores/nodeStore'
import type { NodeId } from '../shared/ids'
import { TerminalView } from './TerminalView'
import { Composer } from './Composer'
import { useVisualViewportVars } from './viewport'

/**
 * The phone: the desktop's canvas for getting around, with a full-screen view
 * for whichever terminal is focused, the toolbar as a sheet, and a composer.
 *
 * The canvas is the desktop's own `App`, untouched but for one flag (see
 * surfacePresenterStore): focusing a terminal works as it always has, and
 * this draws the result.
 */

/** Survives the reload that follows a reconnect, so a dropped link does not lose your place. */
const OPEN_KEY = 'mobile.openTerminal'

function rememberOpen(nodeId: NodeId | null): void {
  try {
    if (nodeId) sessionStorage.setItem(OPEN_KEY, nodeId)
    else sessionStorage.removeItem(OPEN_KEY)
  } catch { /* private mode */ }
}

export function MobileApp() {
  const focusedTerminal = useSurfacePresenterStore((s) => s.focusedTerminal)
  const [composerFor, setComposerFor] = useState<NodeId | null>(null)
  useVisualViewportVars()

  /**
   * Focused inside the tap that opens the composer, so iOS raises the keyboard
   * there and then; the composer's text box takes the focus over once it
   * mounts, and the keyboard stays up. Focus taken any later than the tap
   * itself would not raise it.
   */
  const keyboardKeeperRef = useRef<HTMLInputElement>(null)

  // Back to where we were after a reload, once the surface is known again.
  const restoring = useNodeStore((s) => {
    try {
      const id = sessionStorage.getItem(OPEN_KEY)
      return id && s.nodes[id] ? (id as NodeId) : null
    } catch { return null }
  })
  const [restored, setRestored] = useState(false)
  useEffect(() => {
    if (restored || !restoring) return
    setRestored(true)
    useSurfacePresenterStore.getState().requestFocus(restoring)
  }, [restoring, restored])

  useEffect(() => {
    if (focusedTerminal) rememberOpen(focusedTerminal)
  }, [focusedTerminal])

  const closeTerminal = () => {
    rememberOpen(null)
    setComposerFor(null)
    useSurfacePresenterStore.getState().requestUnfocus()
  }

  return (
    <>
      <App />
      {!focusedTerminal && (
        // Opens the toolbar, which on the phone is a sheet with the surfaces in it.
        <button
          className="mobile-fab"
          onClick={() => useSurfacePresenterStore.getState().setToolbarSheetOpen(true)}
          aria-label="Toolbar and surfaces"
        >
          ☰
        </button>
      )}
      {focusedTerminal && (
        <TerminalView
          key={focusedTerminal}
          nodeId={focusedTerminal}
          onClose={closeTerminal}
          onCompose={() => {
            keyboardKeeperRef.current?.focus()
            setComposerFor(focusedTerminal)
          }}
        />
      )}
      <input ref={keyboardKeeperRef} className="mobile-keyboard-keeper" aria-hidden tabIndex={-1} />
      {composerFor && <Composer nodeId={composerFor} onClose={() => setComposerFor(null)} />}
    </>
  )
}
