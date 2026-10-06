import { useEffect, useState } from 'react'
import { holdState, onHoldStateChange, setHoldMicrophone, type HoldState } from './held-microphone'
import { useHandsFree } from './hands-free'
import { nativeMicrophoneAvailable } from './native-microphone'

/** In a browser: holding needs AirPods, and is only about starting dictation instantly. */
const BROWSER_LABELS: Record<HoldState, string> = {
  off: 'Hold the microphone open with AirPods, so dictation starts instantly',
  preparing: 'Getting the microphone ready to hold open — needs AirPods, and a tap after the app comes back. Tap to turn off',
  held: 'Microphone held open with AirPods — start talking with "Control", and stop when you are done. Tap to let it close between dictations',
}

/** In the app: the app holds the microphone itself, with or without AirPods, and listens for "Control". */
const APP_LABELS: Record<HoldState, string> = {
  off: 'Always listen: start talking with "Control", and stop when you are done — no button, no AirPods needed',
  preparing: 'Starting the microphone to listen for "Control". Tap to turn off',
  held: 'Listening for "Control" at the start of what you say — everything else is ignored. Tap to stop listening',
}

/**
 * Keep the microphone open, right of the talk button in the bottom bar — and
 * with it hands-free mode (hands-free.ts): start talking with "Control", stop
 * when you are done, and Control gets it without a press.
 * Outlined and pulsing while it is on but not holding the microphone yet;
 * white once it is; blue while the conversation window is open (no need to
 * say "Control"); orange and turning while hands-free is taking down what you
 * say.
 * In a browser it only takes effect with a headset — see held-microphone.ts.
 * Remembered on this phone.
 */
export function HoldMicButton() {
  const [state, setState] = useState(holdState)
  useEffect(() => onHoldStateChange(setState), [])
  const phase = useHandsFree((s) => s.phase)
  const conversation = useHandsFree((s) => s.conversation)
  const secondsLeft = useHandsFree((s) => s.secondsLeft)
  const counting = state === 'held' && conversation && phase === 'listening' && secondsLeft !== null
  const on = state !== 'off'
  const hearing = phase === 'hearing' || phase === 'sending'
  const look = phase === 'hearing' ? ' m-hold-mic--hearing' : phase === 'sending' ? ' m-hold-mic--sending'
    : state === 'held' ? (conversation ? ' m-hold-mic--conversation' : ' m-hold-mic--on') : state === 'preparing' ? ' m-hold-mic--preparing' : ''
  const label = hearing
    ? phase === 'hearing' ? 'Listening to you — stop talking to send' : 'Sending what you said to Control'
    : state === 'held' && conversation
      ? `In conversation with Control: just talk, no need to say "Control"${secondsLeft !== null ? ` — ${secondsLeft} seconds of quiet left` : ''}`
      : (nativeMicrophoneAvailable() ? APP_LABELS : BROWSER_LABELS)[state]
  return (
    <button
      className={`m-hold-mic${look}`}
      aria-pressed={on}
      aria-label={label}
      onClick={() => setHoldMicrophone(!on)}
    >
      {/* The conversation window's countdown, in place of the icon: seconds of quiet left before "Control" is needed again. */}
      {counting ? <span className="m-hold-mic__countdown">{secondsLeft}</span> : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="7" y="3" width="6" height="10" rx="3" />
        <path d="M3.5 10a6.5 6.5 0 0 0 13 0" />
        <path d="M10 16.5V20" />
        {/* A small lock: held. */}
        <rect x="15" y="15" width="7" height="6" rx="1" fill="currentColor" stroke="none" />
        <path d="M16.5 15v-1.5a2 2 0 0 1 4 0V15" strokeWidth="1.6" />
      </svg>}
    </button>
  )
}
