import { useEffect, useState } from 'react'
import { App } from '@/App'
import { useSurfacePresenterStore } from '@/stores/surfacePresenterStore'
import { useNodeStore } from '@/stores/nodeStore'
import type { NodeId } from '../shared/ids'
import { TerminalView } from './TerminalView'
import { Composer } from './Composer'
import { SurfaceList } from './SurfaceList'

/**
 * The phone: the desktop's canvas for getting around, with a full-screen view
 * for whichever terminal is focused, a surface list, and a composer.
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
  const [listOpen, setListOpen] = useState(false)

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
        <button className="mobile-fab" onClick={() => setListOpen(true)} aria-label="Surfaces">☰</button>
      )}
      {listOpen && (
        <SurfaceList
          onPick={(nodeId) => {
            setListOpen(false)
            useSurfacePresenterStore.getState().requestFocus(nodeId)
          }}
          onClose={() => setListOpen(false)}
        />
      )}
      {focusedTerminal && (
        <TerminalView
          key={focusedTerminal}
          nodeId={focusedTerminal}
          onClose={closeTerminal}
          onCompose={() => setComposerFor(focusedTerminal)}
        />
      )}
      {composerFor && <Composer nodeId={composerFor} onClose={() => setComposerFor(null)} />}
    </>
  )
}
