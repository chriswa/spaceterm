import { LET_ME_TURN_THIS_OFF } from '../shared/control-shutdown'
import { useMicActivity } from './dictation'
import { useHoldState } from './HandsFreeButton'

/**
 * "MIC" in orange above the Dynamic Island while what you say is being
 * transcribed — the colour of iOS's own microphone dot, which says only that
 * a microphone is open. Hands-free mode holds one open all the time; this says
 * when it, or any dictation, is actually sending your voice to be written
 * down. Solid while audio is going out, pulsing while the words are waited for.
 *
 * While the microphone is merely held — always-on mode — the same place shows
 * “let me turn this off”, quoted, in cyan instead: a reminder of the phrase that sends
 * Control away (control-shutdown.ts). "MIC" replaces it whenever it shows.
 */
export function MicIndicator() {
  return <MicLabel alwaysOn={useHoldState() !== 'off'} />
}

/** What the label shows, given whether always-on mode is on: see `MicIndicator`. */
export function MicLabel({ alwaysOn }: { alwaysOn: boolean }) {
  const capturing = useMicActivity((s) => s.capturing > 0)
  const transcribing = useMicActivity((s) => s.transcribing > 0)
  if (!capturing && !transcribing) {
    if (!alwaysOn) return null
    return (
      <div className="m-mic-label m-mic-label--reminder" aria-label={`Say "${LET_ME_TURN_THIS_OFF.join(' ')}" to send Control away`}>
        “{LET_ME_TURN_THIS_OFF.join(' ')}”
      </div>
    )
  }
  return (
    <div
      className={`m-mic-label${capturing ? '' : ' m-mic-label--waiting'}`}
      role="status"
      aria-label={capturing ? 'Transcribing what you say' : 'Waiting for the transcript'}
    >
      MIC
    </div>
  )
}
