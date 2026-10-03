import { useEffect, useState } from 'react'
import { holdState, onHoldStateChange, setHoldMicrophone, type HoldState } from './held-microphone'

const LABELS: Record<HoldState, string> = {
  off: 'Hold the microphone open with AirPods, so dictation starts instantly',
  preparing: 'Getting the microphone ready to hold open — needs AirPods, and a tap after the app comes back. Tap to turn off',
  held: 'Microphone held open with AirPods — tap to let it close between dictations',
}

/**
 * Keep the microphone open between dictations, right of the talk button.
 * Outlined and pulsing while it is on but not holding the microphone yet;
 * lit once it is. Only takes effect with a headset — see held-microphone.ts.
 * Remembered on this phone.
 */
export function HoldMicButton() {
  const [state, setState] = useState(holdState)
  useEffect(() => onHoldStateChange(setState), [])
  const on = state !== 'off'
  return (
    <button
      className={`m-hold-mic${state === 'held' ? ' m-hold-mic--on' : state === 'preparing' ? ' m-hold-mic--preparing' : ''}`}
      aria-pressed={on}
      aria-label={LABELS[state]}
      onClick={() => setHoldMicrophone(!on)}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="7" y="3" width="6" height="10" rx="3" />
        <path d="M3.5 10a6.5 6.5 0 0 0 13 0" />
        <path d="M10 16.5V20" />
        {/* A small lock: held. */}
        <rect x="15" y="15" width="7" height="6" rx="1" fill="currentColor" stroke="none" />
        <path d="M16.5 15v-1.5a2 2 0 0 1 4 0V15" strokeWidth="1.6" />
      </svg>
    </button>
  )
}
