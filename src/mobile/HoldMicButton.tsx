import { useEffect, useState } from 'react'
import { holdsMicrophone, onHoldChange, setHoldMicrophone } from './held-microphone'

/**
 * Keep the microphone open between dictations, right of the talk button. Lit
 * while on. Only takes effect with a headset — see held-microphone.ts.
 * Remembered on this phone.
 */
export function HoldMicButton() {
  const [on, setOn] = useState(holdsMicrophone)
  useEffect(() => onHoldChange(setOn), [])
  return (
    <button
      className={`m-hold-mic${on ? ' m-hold-mic--on' : ''}`}
      aria-pressed={on}
      aria-label={on ? 'Microphone held open with AirPods — tap to let it close between dictations' : 'Hold the microphone open with AirPods, so dictation starts instantly'}
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
