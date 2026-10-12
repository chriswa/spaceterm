import { useControlTranscriptStore } from '@/stores/controlTranscriptStore'
import { anyOf, createGate, whileOn, type Gate } from './gate'
import { pageHidden, setCanvasCovered } from './browser-platform'

/**
 * Control mode: the phone only talking to Control, its canvas out of sight —
 * Control's transcript is up, or the screen is off (the phone in a pocket,
 * still holding Control). Nothing the canvas does could be seen, so it does
 * nothing:
 *
 * - it is covered (`setCanvasCovered`), which stops every canvas loop, card
 *   painting and camera flights, and the clock behind the elapsed captions;
 * - the server stops sending it terminal snapshots (`pauseCanvas`), which were
 *   nearly all the phone received — about 6 MB a minute with 25 terminals —
 *   and sends each card's current screen when it is back.
 *
 * Everything else still arrives and lands in its store, so nothing is
 * replayed on the way back: the canvas draws what the stores already hold.
 * See docs/ideas/phone-control-mode.md for the measurements behind this.
 */

export interface ControlModeDeps {
  /** The server half: snapshots off while paused. */
  pauseCanvas(paused: boolean): void
  log(message: string): void
  record(kind: string, detail: Record<string, unknown>): void
}

/** On while Control's transcript is open. */
function transcriptOpenGate(): Gate {
  const gate = createGate(useControlTranscriptStore.getState().open)
  useControlTranscriptStore.subscribe((state) => gate.set(state.open))
  return gate
}

/** Control mode, as a gate; see the module comment. */
export function controlModeGate(transcriptOpen: Gate = transcriptOpenGate(), hidden: Gate = pageHidden): Gate {
  return anyOf(transcriptOpen, hidden)
}

/**
 * While `mode` is on, cover the canvas and pause it on the server. Uncovered
 * first on the way out, so the fresh screens the server sends on resume are
 * painted as they arrive rather than put aside.
 */
export function installControlMode(mode: Gate, deps: ControlModeDeps): () => void {
  return whileOn(mode, () => {
    const since = Date.now()
    deps.log('[control-mode] on: canvas covered, snapshots paused')
    deps.record('control-mode', { on: true })
    setCanvasCovered('control', true)
    deps.pauseCanvas(true)
    return () => {
      setCanvasCovered('control', false)
      deps.pauseCanvas(false)
      const seconds = Math.round((Date.now() - since) / 1000)
      deps.log(`[control-mode] off after ${seconds}s: canvas resumed`)
      deps.record('control-mode', { on: false, seconds })
    }
  })
}
