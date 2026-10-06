import { useMicActivity } from './dictation'

/**
 * "MIC" in orange above the Dynamic Island while what you say is being
 * transcribed — the colour of iOS's own microphone dot, which says only that
 * a microphone is open. Hands-free mode holds one open all the time; this says
 * when it, or any dictation, is actually sending your voice to be written
 * down. Solid while audio is going out, pulsing while the words are waited for.
 * Nothing while the microphone is merely held.
 */
export function MicIndicator() {
  const capturing = useMicActivity((s) => s.capturing > 0)
  const transcribing = useMicActivity((s) => s.transcribing > 0)
  if (!capturing && !transcribing) return null
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
