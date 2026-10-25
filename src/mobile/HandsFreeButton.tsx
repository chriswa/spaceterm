import { useEffect, useRef, useState } from 'react'
import { holdState, onHoldStateChange, setHoldMicrophone, type HoldState } from './held-microphone'
import { nativeMicrophoneAvailable, onNativeSampleRate } from './native-microphone'
import { endSilence, setHandsFree, useHandsFree } from './hands-free'
import { Spark } from './Spark'
import './HandsFreeButton.css'

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

/** The button's radius in its gauges' 42-unit box. */
const R = 21

/** A line across the left half of the disc, `at` (0..1) of the way up: where the turn model's threshold is. */
export function thresholdLine(at: number): { x1: number; x2: number; y: number } {
  const y = 2 * R * (1 - Math.max(0, Math.min(1, at)))
  return { x1: R - Math.sqrt(Math.max(0, R * R - (y - R) ** 2)), x2: R, y }
}

/**
 * The hands-free button, right of the microphone: a tap holds the microphone
 * open (held-microphone.ts), and another lets it go. In the app, holding it is
 * hands-free (hands-free.ts) — start talking with "Control" and Control gets
 * it without a press; in a browser, only with AirPods, and only so a dictation
 * starts without the headset renegotiating. Inside the tap, as iOS requires
 * of a page opening a microphone.
 *
 * While hands-free is taking a dictation, the button shows the two things
 * that can end it, a half each, filling from the bottom like a glass.
 * Left, green: the turn model's latest answer at a pause (Smart Turn), 0 to
 * 1, snapping to each answer; a red line across it marks the threshold that
 * ends the dictation, while the model is being asked. Right: the quiet since
 * you last spoke, the top the patience that ends it regardless. Both stay up while what you said is sent,
 * so you can see which one ended it.
 *
 * The same button on the Mac, in the toolbar beside Control (`chrome:
 * 'toolbar'`): there it holds the Mac's input, and holding it is hands-free.
 * `unavailable` says why it cannot run there; the button then does nothing
 * and its tooltip gives the reason.
 */
export function HandsFreeButton({ chrome = 'phone-bar', unavailable }: { chrome?: 'phone-bar' | 'toolbar'; unavailable?: string }) {
  const held = useHoldState()
  /** On the Mac, Voice Operator holds its own microphone: the button only switches hands-free. */
  const desktop = chrome === 'toolbar'
  const wanted = useHandsFree((s) => s.on)
  const listening = useHandsFree((s) => s.phase !== 'off')
  const hold: HoldState = desktop ? (wanted ? (listening ? 'held' : 'preparing') : 'off') : held
  const on = hold !== 'off'
  const app = nativeMicrophoneAvailable()
  /** Holding is hands-free mode: in the app, and on the Mac. */
  const handsFree = app || desktop
  // While hands-free holds the app's microphone: its link's rate in kHz, 24 or 48 on AirPods. Shown only.
  const rate = useNativeSampleRate()
  const badge = app && hold === 'held' && rate ? String(Math.round(rate / 1000)) : null
  const phase = useHandsFree((s) => s.phase)
  const turn = useHandsFree((s) => s.turn)
  const sampling = useHandsFree((s) => s.sampling)
  const line = sampling === null ? null : thresholdLine(sampling)
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

  const label = unavailable ?? (on
    ? `${hold === 'preparing' ? 'Getting the microphone ready' : handsFree ? 'Hands-free: always listening for "Control"' : 'Microphone held open'} — ${chrome === 'toolbar' ? 'click' : 'tap'} to stop`
    : handsFree ? 'Hands-free: always listen for "Control"' : 'Hold the microphone open with AirPods')
  return (
    <button
      className={`${chrome === 'toolbar' ? 'toolbar__btn toolbar__hands-free' : 'm-bar__button'} m-hands-free m-hands-free--${hold}`}
      aria-label={label}
      aria-pressed={on}
      // aria-disabled rather than disabled, so the tooltip giving the reason still shows on hover.
      aria-disabled={unavailable !== undefined}
      {...chrome === 'toolbar' ? { 'data-tooltip': label, 'data-tooltip-no-flip': true } : {}}
      // No haptic: a tap means your words are being taken down (native-microphone.ts). The press shows instead.
      onClick={() => {
        if (unavailable !== undefined) return
        if (desktop) setHandsFree(!on)
        else setHoldMicrophone(!on)
      }}
    >
      {/* Turned on, the microphone not held yet: a spark round the rim until it is. */}
      {hold === 'preparing' && <Spark />}
      {ending && (
        <>
          <svg className="m-hands-free__gauge m-hands-free__gauge--turn" viewBox="0 0 42 42" aria-hidden="true"
            style={{ clipPath: clipTo(turn?.p ?? 0) }}>
            {/* The left half of the disc. */}
            <path d="M21 0A21 21 0 0 0 21 42Z" />
          </svg>
          {line && (
            <svg className="m-hands-free__gauge m-hands-free__threshold" viewBox="0 0 42 42" aria-hidden="true">
              <line x1={line.x1} x2={line.x2} y1={line.y} y2={line.y} />
            </svg>
          )}
          <svg ref={quietRef} className="m-hands-free__gauge m-hands-free__gauge--quiet" viewBox="0 0 42 42" aria-hidden="true"
            style={{ clipPath: clipTo(0) }}>
            <path d="M21 0A21 21 0 0 1 21 42Z" />
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
    <svg className="m-hands-free__icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 9.5a5.5 5.5 0 0 1 11 0c0 3.2-3.2 4.2-3.2 7.3a3.3 3.3 0 0 1-6 1.9" />
      <path d="M13.3 9.5a2.2 2.2 0 0 1 4.4 0c0 1.3-1.3 1.7-1.7 2.8" />
      <path d="M6 8a5.7 5.7 0 0 1 0 8" />
      <path d="M2.5 5a10.5 10.5 0 0 1 0 14" />
    </svg>
  )
}
