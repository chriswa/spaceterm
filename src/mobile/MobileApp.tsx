import { useEffect, useRef, useState } from 'react'
import { App } from '@/App'
import { useSurfacePresenterStore } from '@/stores/surfacePresenterStore'
import { useNodeStore } from '@/stores/nodeStore'
import type { NodeId } from '../shared/ids'
import { TerminalView } from './TerminalView'
import { Composer } from './Composer'
import { useVisualViewportVars } from './viewport'
import { Dictation } from './dictation'
import { primeCues } from './cues'
import { setCanvasCovered } from './browser-platform'
import { UsageReadout } from './UsageReadout'
import { UpdateBadge } from './UpdateBadge'
import { SummarizerButton } from './SummarizerButton'
import { useDictationSession } from './dictation-session'
import { DictationIndicator } from './DictationIndicator'
import { useSummaryChatStore } from '@/stores/summaryChatStore'

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
  /** The surface Summary Chat is talking about, while a conversation is open. */
  const summaryTarget = useSummaryChatStore((s) => s.targetNodeId)
  useVisualViewportVars()

  /**
   * Focused inside the tap that opens the composer, so iOS raises the keyboard
   * there and then; the composer's text box takes the focus over once it
   * mounts, and the keyboard stays up. Focus taken any later than the tap
   * itself would not raise it.
   */
  const keyboardKeeperRef = useRef<HTMLInputElement>(null)
  /** Dictating, with no composer open to show it: the bottom row's mic says so. */
  const dictating = useDictationSession((s) => s.mic.kind !== 'idle')

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
    // The terminal view covers the whole canvas: let it stop drawing.
    setCanvasCovered(focusedTerminal !== null)
  }, [focusedTerminal])

  const closeTerminal = () => {
    // Now, not from the effect after the re-render: the canvas's zoom-out on
    // the way back starts first, and a covered canvas snaps where it would fly.
    setCanvasCovered(false)
    rememberOpen(null)
    setComposerFor(null)
    useSurfacePresenterStore.getState().requestUnfocus()
  }

  return (
    <>
      <App />
      {!focusedTerminal && <UsageReadout />}
      {!focusedTerminal && <UpdateBadge />}
      {!focusedTerminal && (
        // Opens the toolbar, which on the phone is a sheet with the surfaces in it.
        <button
          className="mobile-fab"
          onClick={() => useSurfacePresenterStore.getState().setToolbarSheetOpen(true)}
          aria-label="Toolbar and surfaces"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            {/* A rocket climbing to the upper right. */}
            <path d="M20.6 3.4c-3.9-.3-7.6 1.3-10.2 4.3L8.9 9.4l-3.6.4L3 12.1l3.7 1.2 4 4 1.2 3.7 2.3-2.3.4-3.6 1.7-1.5c3-2.6 4.6-6.3 4.3-10.2zM15.5 10.4a1.9 1.9 0 1 1 0-3.8 1.9 1.9 0 0 1 0 3.8z" />
            <path d="M6.2 15.9c-1.3.4-2.2 1.9-2.6 4.5 2.6-.4 4.1-1.3 4.5-2.6z" opacity="0.7" />
          </svg>
        </button>
      )}
      {focusedTerminal && (
        <TerminalView
          key={focusedTerminal}
          nodeId={focusedTerminal}
          onClose={closeTerminal}
          onCompose={() => {
            // All inside the tap, which is what lets iOS raise the keyboard,
            // open the microphone and play sound.
            keyboardKeeperRef.current?.focus()
            primeCues()
            // The composer opens into dictation — unless one is already going,
            // started in another composer: this one takes it over.
            if (useDictationSession.getState().mic.kind === 'idle') {
              void useDictationSession.getState().start(Dictation.begin(window.api.dictation))
            }
            setComposerFor(focusedTerminal)
          }}
        />
      )}
      <input ref={keyboardKeeperRef} className="mobile-keyboard-keeper" aria-hidden tabIndex={-1} />
      {composerFor && (
        <Composer
          // Keyed, so opening another surface's composer starts fresh on its draft.
          key={composerFor}
          nodeId={composerFor}
          onClose={() => setComposerFor(null)}
          // Dictation carries on either way; see dictation-session.ts.
          onExitToCanvas={closeTerminal}
        />
      )}
      {dictating && !composerFor && <DictationIndicator />}
      {/* Over the canvas and the terminal view alike; the composer has its own microphone. */}
      {summaryTarget && !composerFor && <SummarizerButton key={summaryTarget} nodeId={summaryTarget} />}
    </>
  )
}
