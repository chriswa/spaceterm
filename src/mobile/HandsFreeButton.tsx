import { useEffect, useId, useRef, useState } from 'react'
import { holdState, onHoldStateChange, setHoldMicrophone, type HoldState } from './held-microphone'
import { nativeMicrophoneAvailable } from './native-microphone'
import { endSilence, setHandsFree, useHandsFree } from './hands-free'
import { Spark } from './Spark'
import { conversationLeft } from './mic-button'
import './HandsFreeButton.css'

/** Whether the microphone is held open (held-microphone.ts), as it changes. */
export function useHoldState(): HoldState {
  const [hold, setHold] = useState(holdState)
  useEffect(() => onHoldStateChange(setHold), [])
  return hold
}

/** Fill an end gauge `fill` (0..1) of the way up, from the bottom. */
const clipTo = (fill: number) => `inset(${(100 * (1 - Math.max(0, Math.min(1, fill)))).toFixed(1)}% 0 0 0)`

/** The button's radius in its gauges' 42-unit box. */
const R = 21

/** The disc in thirds, left to right: Smart Turn, turn-1-mini, the quiet. */
const THIRD = (2 * R) / 3
export const BARS = { turn: [0, THIRD], mini: [THIRD, 2 * THIRD], quiet: [2 * THIRD, 2 * R] } as const

/**
 * A line across one bar (`[x0, x1]`) of the disc, `at` (0..1) of the way up,
 * trimmed to the disc's edge: where a threshold, or a peak, is.
 */
export function thresholdLine(at: number, [x0, x1]: readonly [number, number] = BARS.turn): { x1: number; x2: number; y: number } {
  const y = 2 * R * (1 - Math.max(0, Math.min(1, at)))
  const half = Math.sqrt(Math.max(0, R * R - (y - R) ** 2))
  return { x1: Math.max(x0, R - half), x2: Math.min(x1, R + half), y }
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
 * A third each. Left, green: Smart Turn's one answer about this pause (asked
 * 0.5 s in), 0 to 1, with a red line at the threshold that ends the dictation
 * there. Middle, yellow: turn-1-mini, on trial and deciding nothing — its
 * latest answer, a red line at its model card's threshold, and a dark tick at
 * its highest since the pause began, the peak hold: a tick above the line
 * means it would have ended the turn. Right: the quiet since
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
  const phase = useHandsFree((s) => s.phase)
  const conversation = useHandsFree((s) => s.conversation)
  const secondsLeft = useHandsFree((s) => s.secondsLeft)
  const checking = useHandsFree((s) => s.checking)
  const turn = useHandsFree((s) => s.turn)
  const sampling = useHandsFree((s) => s.sampling)
  const mini = useHandsFree((s) => s.mini)
  // The threshold the pause's one answer was held to, beside it — and while it is being asked.
  const threshold = sampling ?? turn?.threshold ?? null
  const line = threshold === null ? null : thresholdLine(threshold, BARS.turn)
  const miniLine = mini ? thresholdLine(mini.threshold, BARS.mini) : null
  const miniPeak = mini?.peak != null ? thresholdLine(mini.peak, BARS.mini) : null
  const clip = useId().replace(/:/g, '')
  const ending = phase === 'hearing' || phase === 'sending'
  /** The conversation window's length: `secondsLeft` at its fullest, which it is when it opens. */
  const fullest = useRef(0)
  if (!conversation) fullest.current = 0
  else if (secondsLeft !== null) fullest.current = Math.max(fullest.current, secondsLeft)
  const windowOpen = on && conversation && !ending

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
    ? `${hold === 'preparing' ? 'Getting the microphone ready'
      : checking && !ending ? 'Hands-free: heard something — checking whether it was for Control'
      : windowOpen ? `Hands-free, in conversation with Control: just talk, no need to say "Control"${secondsLeft !== null ? ` — ${secondsLeft} seconds of quiet left` : ''}`
      : handsFree ? 'Hands-free: always listening for "Control"' : 'Microphone held open'} — ${chrome === 'toolbar' ? 'click' : 'tap'} to stop`
    : handsFree ? 'Hands-free: always listen for "Control"' : 'Hold the microphone open with AirPods')
  return (
    <button
      className={`${chrome === 'toolbar' ? 'toolbar__btn toolbar__hands-free' : 'm-bar__button'} m-hands-free m-hands-free--${hold}${checking && on && !ending ? ' m-hands-free--checking' : ''}`}
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
      {windowOpen && (
        // The conversation window: no "Control" needed until this ring has drained.
        <svg className="m-hands-free__ring" viewBox="0 0 42 42" aria-hidden="true">
          <circle cx="21" cy="21" r="19.5" pathLength="100" strokeDasharray="100"
            strokeDashoffset={100 * (1 - conversationLeft(secondsLeft, fullest.current))} />
        </svg>
      )}
      {ending && (
        <>
          {/* Each bar is a third of the disc, filled from the bottom (clipTo). */}
          <svg className="m-hands-free__gauge m-hands-free__gauge--turn" viewBox="0 0 42 42" aria-hidden="true"
            style={{ clipPath: clipTo(turn?.p ?? 0) }}>
            <defs><clipPath id={`${clip}-turn`}><rect x={BARS.turn[0]} width={THIRD} height={42} /></clipPath></defs>
            <circle cx={R} cy={R} r={R} clipPath={`url(#${clip}-turn)`} />
          </svg>
          <svg className="m-hands-free__gauge m-hands-free__gauge--mini" viewBox="0 0 42 42" aria-hidden="true"
            style={{ clipPath: clipTo(mini?.p ?? 0) }}>
            <defs><clipPath id={`${clip}-mini`}><rect x={BARS.mini[0]} width={THIRD} height={42} /></clipPath></defs>
            <circle cx={R} cy={R} r={R} clipPath={`url(#${clip}-mini)`} />
          </svg>
          <svg ref={quietRef} className="m-hands-free__gauge m-hands-free__gauge--quiet" viewBox="0 0 42 42" aria-hidden="true"
            style={{ clipPath: clipTo(0) }}>
            <defs><clipPath id={`${clip}-quiet`}><rect x={BARS.quiet[0]} width={THIRD} height={42} /></clipPath></defs>
            <circle cx={R} cy={R} r={R} clipPath={`url(#${clip}-quiet)`} />
          </svg>
          <svg className="m-hands-free__gauge m-hands-free__lines" viewBox="0 0 42 42" aria-hidden="true">
            {line && <line className="m-hands-free__threshold" x1={line.x1} x2={line.x2} y1={line.y} y2={line.y} />}
            {miniLine && <line className="m-hands-free__threshold" x1={miniLine.x1} x2={miniLine.x2} y1={miniLine.y} y2={miniLine.y} />}
            {/* turn-1-mini's highest since the pause began: above the red line, it would have ended the turn. */}
            {miniPeak && <line className="m-hands-free__peak" x1={miniPeak.x1} x2={miniPeak.x2} y1={miniPeak.y} y2={miniPeak.y} />}
          </svg>
        </>
      )}
      <HandsFreeIcon />
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
