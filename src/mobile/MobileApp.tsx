import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
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
import { RocketButton } from './RocketButton'
import { useStalenessWatch } from './update-check'
import { SystemStatsReadout } from './SystemStatsReadout'
import { EXTERNAL_UNFOCUS_ZOOM_OUT } from '@/lib/constants'
import { SummarizerButton } from './SummarizerButton'
import { useDictationSession } from './dictation-session'
import { DictationIndicator } from './DictationIndicator'
import { useSummaryChatStore } from '@/stores/summaryChatStore'
import { useReceptionistStore } from '@/stores/receptionistStore'
import { ControlButton } from './ControlButton'
import { HoldMicButton } from './HoldMicButton'
import { BottomBar } from './BottomBar'
import { MicIndicator } from './MicIndicator'
import { ControlTranscript } from '@/components/ControlTranscript'
import { useControlTranscriptStore } from '@/stores/controlTranscriptStore'
import { SWIPE_SCREENS, useSwipeToDismiss, type SwipeScreen } from './swipe-dismiss'
import { useApprovalsStore, useApprovalsWatch } from './approvals-store'
import { NotificationsButton } from './NotificationsButton'
import { NotificationsSheet } from './NotificationsSheet'
import { ApprovalView } from './ApprovalView'

/**
 * The phone: the desktop's canvas for getting around, with a full-screen view
 * for whichever terminal is focused, the toolbar as a sheet, and a composer.
 *
 * The canvas is the desktop's own `App`, untouched but for one flag (see
 * surfacePresenterStore): focusing a terminal works as it always has, and
 * this draws the result.
 */

/**
 * Leaving the terminal by swiping sideways zooms out twice as far as leaving
 * otherwise: the card left behind ends a quarter of the size it filled.
 */
const SWIPE_EXIT_ZOOM_OUT = EXTERNAL_UNFOCUS_ZOOM_OUT ** 2

/** Survives the reload that follows a reconnect, so a dropped link does not lose your place. */
const OPEN_KEY = 'mobile.openTerminal'

function rememberOpen(nodeId: NodeId | null): void {
  try {
    if (nodeId) sessionStorage.setItem(OPEN_KEY, nodeId)
    else sessionStorage.removeItem(OPEN_KEY)
  } catch { /* private mode */ }
}

/**
 * Keys for this component's children, which are all siblings in one fragment.
 * Several are keyed by a surface — the terminal view, its composer, the talk
 * button — so a bare node id as the key collides whenever two of them are the
 * same surface. React then loses track of which child is which: opening the
 * composer mounted a second terminal view and orphaned the first, whose
 * picture and touch handlers stayed on screen after the terminal was closed —
 * a frozen screen that only refocusing another surface cleared.
 */
const childKey = (kind: 'terminal' | 'composer' | 'talk', id: string) => `${kind}:${id}`

/** `Canvas` is the desktop's App unless a test stands in for it. */
export function MobileApp({ Canvas = App }: { Canvas?: ComponentType } = {}) {
  const focusedTerminal = useSurfacePresenterStore((s) => s.focusedTerminal)
  const toolbarSheetOpen = useSurfacePresenterStore((s) => s.toolbarSheetOpen)
  useStalenessWatch()
  const [composerFor, setComposerFor] = useState<NodeId | null>(null)
  /** The surface Summary Chat is talking about, while a conversation is open. */
  const summaryTarget = useSummaryChatStore((s) => s.targetNodeId)
  /** Control holds the voice target: the talk button speaks to it instead. */
  const controlTarget = useReceptionistStore((s) => s.target)
  /** A conversation to talk into: the talk button and its neighbours are up. */
  const voice = summaryTarget !== null || controlTarget
  /** Control's transcript: the screen above the bottom bar, which stays up to talk and to close it. */
  const transcriptOpen = useControlTranscriptStore((s) => s.open)
  /** The bell's list, and the approval request opened from it (approvals-store.ts). */
  useApprovalsWatch()
  const noticesOpen = useApprovalsStore((s) => s.listOpen)
  const approvalOpen = useApprovalsStore((s) => s.openKey)
  // The transcript, the toolbar sheet and the bell's list are screens, not
  // layers: opening one closes the others.
  useEffect(() => {
    if (!transcriptOpen) return
    useSurfacePresenterStore.getState().setToolbarSheetOpen(false)
    useApprovalsStore.getState().setListOpen(false)
  }, [transcriptOpen])
  useEffect(() => {
    if (!toolbarSheetOpen) return
    useControlTranscriptStore.getState().setOpen(false)
    useApprovalsStore.getState().setListOpen(false)
  }, [toolbarSheetOpen])
  useEffect(() => {
    if (!noticesOpen) return
    useControlTranscriptStore.getState().setOpen(false)
    useSurfacePresenterStore.getState().setToolbarSheetOpen(false)
  }, [noticesOpen])
  // A sideways drag dismisses any of them, as it leaves the terminal view.
  const swipeScreens = useMemo<SwipeScreen[]>(() => [
    ...(transcriptOpen ? [{ ...SWIPE_SCREENS.transcript, dismiss: () => useControlTranscriptStore.getState().setOpen(false) }] : []),
    ...(toolbarSheetOpen ? [{ ...SWIPE_SCREENS.sheet, dismiss: () => useSurfacePresenterStore.getState().setToolbarSheetOpen(false) }] : []),
    ...(noticesOpen ? [{ ...SWIPE_SCREENS.notices, dismiss: () => useApprovalsStore.getState().setListOpen(false) }] : []),
    ...(approvalOpen ? [{ ...SWIPE_SCREENS.approval, dismiss: () => useApprovalsStore.getState().closeItem() }] : []),
  ], [transcriptOpen, toolbarSheetOpen, noticesOpen, approvalOpen])
  useSwipeToDismiss(swipeScreens)
  /** The talk button and its neighbours are up: there is a conversation, or the transcript to talk into. */
  const talk = voice || transcriptOpen
  useVisualViewportVars()

  /**
   * Focused inside the tap that opens the composer, so iOS raises the keyboard
   * there and then; the composer's text box takes the focus over once it
   * mounts, and the keyboard stays up. Focus taken any later than the tap
   * itself would not raise it.
   */
  const keyboardKeeperRef = useRef<HTMLInputElement>(null)
  /** Dictating, with no composer open to show it: the bottom bar says so. */
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
    window.api.log(`[mobile-view] focused terminal ${focusedTerminal ?? 'none'}`)
    if (focusedTerminal) rememberOpen(focusedTerminal)
    // The terminal view covers the whole canvas: let it stop drawing.
    setCanvasCovered(focusedTerminal !== null)
  }, [focusedTerminal])

  /**
   * `zoomOut`: how far the canvas pulls back, when not its default. `from`
   * says which gesture asked, for the log.
   *
   * Only while a terminal is open: the canvas zooms out by `zoomOut` from
   * wherever it is, so a second exit — a stray gesture in the composer as it
   * closed, say — pulled back a further four times, to a canvas so wide its
   * drawing ran the page out of memory, and the reload came back to the same
   * place.
   */
  const closeTerminal = (from: string, zoomOut?: number) => {
    const open = useSurfacePresenterStore.getState().focusedTerminal
    window.api.log(`[mobile-view] terminal close from ${from}${zoomOut === undefined ? '' : ` (zoom out ${zoomOut})`}${open ? '' : ' — none open, ignored'}`)
    setComposerFor(null)
    if (!open) return
    // Now, not from the effect after the re-render: the canvas's zoom-out on
    // the way back starts first, and a covered canvas snaps where it would fly.
    setCanvasCovered(false)
    rememberOpen(null)
    useSurfacePresenterStore.getState().requestUnfocus(zoomOut)
  }

  return (
    <>
      <Canvas />
      {focusedTerminal && (
        <TerminalView
          key={childKey('terminal', focusedTerminal)}
          nodeId={focusedTerminal}
          onClose={(via) => closeTerminal(`the terminal (${via ?? 'pinch or tap'})`, via === 'swipe' ? SWIPE_EXIT_ZOOM_OUT : undefined)}
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
            window.api.log('[mobile-view] composer opened')
            setComposerFor(focusedTerminal)
          }}
        />
      )}
      <input ref={keyboardKeeperRef} className="mobile-keyboard-keeper" aria-hidden tabIndex={-1} />
      {composerFor && (
        <Composer
          // Keyed, so opening another surface's composer starts fresh on its draft.
          key={childKey('composer', composerFor)}
          nodeId={composerFor}
          onClose={() => {
            window.api.log('[mobile-view] composer closed')
            setComposerFor(null)
          }}
          // Always a sideways swipe. Dictation carries on; see dictation-session.ts.
          onExitToCanvas={() => closeTerminal('the composer (swipe)', SWIPE_EXIT_ZOOM_OUT)}
        />
      )}
      <MicIndicator />
      {transcriptOpen && (
        <ControlTranscript
          variant="screen"
          onDismiss={() => useControlTranscriptStore.getState().setOpen(false)}
        />
      )}
      {noticesOpen && <NotificationsSheet />}
      {/* Over everything, bottom bar included: the app's slide panel docks
          where the bar would be. Keyed, so another request starts fresh. */}
      {approvalOpen && <ApprovalView key={approvalOpen} />}
      {/* On the canvas and the terminal view, over the surface list and under
          the transcript. Never over the composer, which has its own microphone. */}
      {(!composerFor || transcriptOpen) && !approvalOpen && (
        <BottomBar
          start={
            // The Mac's two readouts stacked against Control: its system
            // monitor over the AI usage.
            <div className="m-bar__readouts">
              <SystemStatsReadout />
              <UsageReadout />
            </div>
          }
          middle={
            <>
              <ControlButton />
              {talk && (
                // Over the transcript, it talks to Control, whatever the voice target.
                <SummarizerButton
                  key={childKey('talk', controlTarget || transcriptOpen ? 'control' : summaryTarget ?? '')}
                  nodeId={controlTarget || transcriptOpen ? null : summaryTarget}
                />
              )}
              {talk && <HoldMicButton />}
            </>
          }
          end={
            <>
              {dictating && <DictationIndicator />}
              <NotificationsButton />
              <RocketButton />
            </>
          }
        />
      )}
    </>
  )
}
