import { useEffect, useRef, useState } from 'react'
import { holdState, onHoldStateChange, setHoldMicrophone, type HoldState } from './held-microphone'
import { nativeMicrophoneAvailable, onNativeSampleRate } from './native-microphone'
import { endSilence, turnFill, useHandsFree } from './hands-free'
import { Spark } from './Spark'

/** Whether the microphone is held open (held-microphone.ts), as it changes. */
export function useHoldState(): HoldState {
  const [hold, setHold] = useState(holdState)
  useEffect(() => onHoldStateChange(setHold), [])
  return hold
}

/** The app's microphone link's rate, in Hz, as it changes; undefined while it does not run. */
function useNativeSampleRate(): number | undefined {
  const [rate, setRate] = useState<number | undefined>(undefined)
  useEffect(() => onNativeSampleRate(setRate), [])
  return rate
}

/** Fill an end gauge `fill` (0..1) of the way up, from the bottom. */
const clipTo = (fill: number) => `inset(${(100 * (1 - Math.max(0, Math.min(1, fill)))).toFixed(1)}% 0 0 0)`

/**
 * The hands-free button, right of the microphone: a tap holds the microphone
 * open (held-microphone.ts), and another lets it go. In the app, holding it is
 * hands-free (hands-free.ts) — start talking with "Control" and Control gets
 * it without a press; in a browser, only with AirPods, and only so a dictation
 * starts without the headset renegotiating. Inside the tap, as iOS requires
 * of a page opening a microphone.
 *
 * While hands-free is taking a dictation, its rim shows the two things that
 * can end it, each filling from the bottom; whichever reaches the top first
 * ends it. Left: the turn model's latest answer at a pause (Smart Turn), the
 * top its threshold. Right: the quiet since you last spoke, the top the
 * patience that ends it regardless. Both stay up while what you said is sent,
 * so you can see which one ended it.
 */
export function HandsFreeButton() {
  const hold = useHoldState()
  const on = hold !== 'off'
  const app = nativeMicrophoneAvailable()
  // While hands-free holds the app's microphone: its link's rate in kHz, 24 or 48 on AirPods. Shown only.
  const rate = useNativeSampleRate()
  const badge = app && hold === 'held' && rate ? String(Math.round(rate / 1000)) : null
  const phase = useHandsFree((s) => s.phase)
  const turn = useHandsFree((s) => s.turn)
  const ending = phase === 'hearing' || phase === 'sending'

  // The quiet gauge, moved once a frame from the endpointer — not through React.
  const quietRef = useRef<SVGSVGElement>(null)
  useEffect(() => {
    if (!ending || typeof requestAnimationFrame !== 'function') return
    let frame = requestAnimationFrame(function draw() {
      if (quietRef.current) quietRef.current.style.clipPath = clipTo(endSilence() ?? 0)
      frame = requestAnimationFrame(draw)
    })
    return () => cancelAnimationFrame(frame)
  }, [ending])

  const label = on
    ? `${hold === 'preparing' ? 'Getting the microphone ready' : app ? 'Hands-free: always listening for "Control"' : 'Microphone held open'} — tap to stop`
    : app ? 'Hands-free: always listen for "Control"' : 'Hold the microphone open with AirPods'
  return (
    <button
      className={`m-bar__button m-hands-free m-hands-free--${hold}`}
      aria-label={label}
      aria-pressed={on}
      // No haptic: a tap means your words are being taken down (native-microphone.ts). The press shows instead.
      onClick={() => setHoldMicrophone(!on)}
    >
      {/* Turned on, the microphone not held yet: a spark round the rim until it is. */}
      {hold === 'preparing' && <Spark />}
      {ending && (
        <>
          <svg className="m-hands-free__gauge m-hands-free__gauge--turn" viewBox="0 0 42 42" aria-hidden="true"
            style={{ clipPath: clipTo(turn ? turnFill(turn.p, turn.threshold) : 0) }}>
            {/* The left half, bottom to top, a gap at each end so the halves read as two. */}
            <path d="M18.96 40.39A19.5 19.5 0 0 1 18.96 1.61" />
          </svg>
          <svg ref={quietRef} className="m-hands-free__gauge m-hands-free__gauge--quiet" viewBox="0 0 42 42" aria-hidden="true"
            style={{ clipPath: clipTo(0) }}>
            <path d="M23.04 40.39A19.5 19.5 0 0 0 23.04 1.61" />
          </svg>
        </>
      )}
      <HandsFreeIcon />
      {badge && <span className="m-hands-free__rate" title={`Microphone at ${badge} kHz`} aria-hidden="true">{badge}</span>}
    </button>
  )
}

/** An ear, with the sound of a voice arriving at it: always listening, nothing to hold. */
function HandsFreeIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 9.5a5.5 5.5 0 0 1 11 0c0 3.2-3.2 4.2-3.2 7.3a3.3 3.3 0 0 1-6 1.9" />
      <path d="M13.3 9.5a2.2 2.2 0 0 1 4.4 0c0 1.3-1.3 1.7-1.7 2.8" />
      <path d="M6 8a5.7 5.7 0 0 1 0 8" />
      <path d="M2.5 5a10.5 10.5 0 0 1 0 14" />
    </svg>
  )
}
