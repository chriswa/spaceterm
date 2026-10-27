import { useEffect, useId, useRef, useState } from 'react'
import { holdState, onHoldStateChange, setHoldMicrophone, type HoldState } from './held-microphone'
import { nativeMicrophoneAvailable } from './native-microphone'
import { endSilence, setHandsFree, useHandsFree, type AudioRoute } from './hands-free'
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

/** The disc in halves, left to right: turn-1-mini, the quiet. */
export const BARS = { mini: [0, R], quiet: [R, 2 * R] } as const

/**
 * A line across one bar (`[x0, x1]`) of the disc, `at` (0..1) of the way up,
 * trimmed to the disc's edge: where a threshold, or a peak, is.
 */
export function thresholdLine(at: number, [x0, x1]: readonly [number, number] = BARS.mini): { x1: number; x2: number; y: number } {
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
 * While hands-free is taking a dictation, the button shows what may end it,
 * a half each, filling from the bottom like a glass. Left, yellow:
 * turn-1-mini, which ends the dictation — its latest answer, a red line at its
 * threshold, and a dark tick at its highest since the pause began, the peak
 * hold; half a second after it first reaches the line, the dictation ends
 * unless you speak. Right, pink: the quiet since you last spoke, the top the
 * patience that ends it regardless. Both stay up while what you said is sent,
 * so you can see which one ended it.
 *
 * While our own voice plays where the microphone would hear it — Control on
 * the phone's speaker, Voice Operator on the Mac's — hands-free does not
 * listen, so it does not take that voice for you: the ear is struck through
 * and greyed until it is listening again (`standingAside`, from Voice
 * Operator). Its other reasons, a cue or a Fn dictation, are too brief or
 * show elsewhere.
 *
 * While it is on, a badge in its corner says where the sound goes (Voice
 * Operator's `setup`), which decides whether "Control" can cut our voice off:
 * headphones for a headset (it can), a speaker for the phone's or the Mac's
 * own (it cannot: hands-free stands aside while our voice plays), a "?" for a
 * route Voice Operator cannot tell. With Voice Operator's echo experiment
 * listening through our voice on the speaker, the speaker badge turns teal and
 * sounds waves.
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
  const deaf = useHandsFree((s) => s.phase === 'listening' && s.standingAside === 'speech')
  const route = useHandsFree((s) => s.route)
  const echoActive = useHandsFree((s) => s.echoExperiment === 'active')
  // turn-1-mini answers all the time; its bar shows only in a pause (its peak is held from the
  // pause's start) and while what was said is sent, and clears as the speaker carries on, as the quiet does.
  const mini = useHandsFree((s) => (s.mini?.peak != null ? s.mini : null))
  const miniLine = mini ? thresholdLine(mini.threshold, BARS.mini) : null
  const miniPeak = mini?.peak != null ? thresholdLine(mini.peak, BARS.mini) : null
  const clip = useId().replace(/:/g, '')
  const ending = phase === 'hearing' || phase === 'sending'
  /** The conversation window's length: `secondsLeft` at its fullest, which it is when it opens. */
  const fullest = useRef(0)
  if (!conversation) fullest.current = 0
  else if (secondsLeft !== null) fullest.current = Math.max(fullest.current, secondsLeft)
  const windowOpen = on && conversation && !ending
  const notListening = on && deaf

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
      : notListening ? 'Hands-free: not listening while our voice plays out loud, so it does not hear itself'
      : checking && !ending ? 'Hands-free: heard something — checking whether it was for Control'
      : windowOpen ? `Hands-free, in conversation with Control: just talk, no need to say "Control"${secondsLeft !== null ? ` — ${secondsLeft} seconds of quiet left` : ''}`
      : handsFree ? 'Hands-free: always listening for "Control"' : 'Microphone held open'}${handsFree && route ? ` (${routeLabel(route, echoActive)})` : ''} — ${chrome === 'toolbar' ? 'click' : 'tap'} to stop`
    : handsFree ? 'Hands-free: always listen for "Control"' : 'Hold the microphone open with AirPods')
  return (
    <button
      className={`${chrome === 'toolbar' ? 'toolbar__btn toolbar__hands-free' : 'm-bar__button'} m-hands-free m-hands-free--${hold}${checking && on && !ending ? ' m-hands-free--checking' : ''}${notListening ? ' m-hands-free--deaf' : ''}`}
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
          {/* Each bar is half the disc, filled from the bottom (clipTo). */}
          <svg className="m-hands-free__gauge m-hands-free__gauge--mini" viewBox="0 0 42 42" aria-hidden="true"
            style={{ clipPath: clipTo(mini?.p ?? 0) }}>
            <defs><clipPath id={`${clip}-mini`}><rect x={BARS.mini[0]} width={R} height={42} /></clipPath></defs>
            <circle cx={R} cy={R} r={R} clipPath={`url(#${clip}-mini)`} />
          </svg>
          <svg ref={quietRef} className="m-hands-free__gauge m-hands-free__gauge--quiet" viewBox="0 0 42 42" aria-hidden="true"
            style={{ clipPath: clipTo(0) }}>
            <defs><clipPath id={`${clip}-quiet`}><rect x={BARS.quiet[0]} width={R} height={42} /></clipPath></defs>
            <circle cx={R} cy={R} r={R} clipPath={`url(#${clip}-quiet)`} />
          </svg>
          <svg className="m-hands-free__gauge m-hands-free__lines" viewBox="0 0 42 42" aria-hidden="true">
            {miniLine && <line className="m-hands-free__threshold" x1={miniLine.x1} x2={miniLine.x2} y1={miniLine.y} y2={miniLine.y} />}
            {/* turn-1-mini's highest since the pause began: above the red line, it would have ended the turn. */}
            {miniPeak && <line className="m-hands-free__peak" x1={miniPeak.x1} x2={miniPeak.x2} y1={miniPeak.y} y2={miniPeak.y} />}
          </svg>
        </>
      )}
      <HandsFreeIcon struck={notListening} />
      {on && handsFree && route && <RouteBadge route={route} echoActive={echoActive} />}
    </button>
  )
}

/** The badge's words, in the button's label and tooltip. */
function routeLabel(route: AudioRoute, echoActive: boolean): string {
  if (route === 'ear') return 'sound in your ears: say "Control" to cut in'
  if (route === 'unsure') return 'cannot tell whether the microphone hears our voice'
  return echoActive
    ? 'sound on the speaker, echo cancellation experiment: say "Control" to cut in'
    : 'sound on the speaker: not listening while our voice plays'
}

/**
 * Where the sound goes, in the button's corner: headphones, a speaker (teal
 * and sounding, with the echo experiment listening through it), or "?".
 */
function RouteBadge({ route, echoActive }: { route: AudioRoute; echoActive: boolean }) {
  const kind = route === 'open' && echoActive ? 'echo' : route
  return (
    <span className={`m-hands-free__route m-hands-free__route--${kind}`} data-route={kind} aria-hidden="true">
      {route === 'unsure' ? '?' : (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          {route === 'ear' ? (
            <>
              <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
              <path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z" />
            </>
          ) : (
            <>
              <path d="M11 5 6 9H2v6h4l5 4z" />
              {echoActive && <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" />}
            </>
          )}
        </svg>
      )}
    </span>
  )
}

/**
 * An ear, with the sound of a voice arriving at it: always listening, nothing
 * to hold. `struck`: crossed out, as a muted microphone is — not listening.
 */
function HandsFreeIcon({ struck = false }: { struck?: boolean }) {
  return (
    <svg className="m-hands-free__icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 9.5a5.5 5.5 0 0 1 11 0c0 3.2-3.2 4.2-3.2 7.3a3.3 3.3 0 0 1-6 1.9" />
      <path d="M13.3 9.5a2.2 2.2 0 0 1 4.4 0c0 1.3-1.3 1.7-1.7 2.8" />
      <path d="M6 8a5.7 5.7 0 0 1 0 8" />
      <path d="M2.5 5a10.5 10.5 0 0 1 0 14" />
      {struck && (
        <>
          {/* A gap in the button's colour either side of the stroke, so it reads over the ear. */}
          <path className="m-hands-free__strike-gap" d="M3 3l18 18" />
          <path className="m-hands-free__strike" d="M3 3l18 18" />
        </>
      )}
    </svg>
  )
}
