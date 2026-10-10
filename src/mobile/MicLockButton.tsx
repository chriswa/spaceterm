import { useEffect, useState } from 'react'
import { holdState, onHoldStateChange, setHoldMicrophone, type HoldState } from './held-microphone'
import { nativeHaptic, nativeMicrophoneAvailable } from './native-microphone'

/** Whether the microphone is held open (held-microphone.ts), as it changes. */
export function useHoldState(): HoldState {
  const [hold, setHold] = useState(holdState)
  useEffect(() => onHoldStateChange(setHold), [])
  return hold
}

/**
 * Hands-free's switch, right of the microphone: a tap holds the microphone
 * open (held-microphone.ts), and another lets it go. In the app, holding it is
 * hands-free (hands-free.ts) — start talking with "Control" and Control gets
 * it without a press; in a browser, only with AirPods, and only so a dictation
 * starts without the headset renegotiating. Inside the tap, as iOS requires
 * of a page opening a microphone.
 */
export function MicLockButton() {
  const hold = useHoldState()
  const on = hold !== 'off'
  const app = nativeMicrophoneAvailable()
  const label = on
    ? `${hold === 'preparing' ? 'Getting the microphone ready' : app ? 'Always listening for "Control"' : 'Microphone held open'} — tap to stop`
    : app ? 'Always listen for "Control"' : 'Hold the microphone open with AirPods'
  return (
    <button
      className={`m-bar__button m-mic-lock m-mic-lock--${hold}`}
      aria-label={label}
      aria-pressed={on}
      onClick={() => {
        nativeHaptic()
        setHoldMicrophone(!on)
      }}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="5" y="11" width="14" height="10" rx="2" />
        {/* Shut while it holds the microphone; open while it does not. */}
        <path d={on ? 'M8 11V7a4 4 0 0 1 8 0v4' : 'M8 11V7a4 4 0 0 1 7.5-2'} />
      </svg>
    </button>
  )
}
