import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { useSummaryChatStore } from '@/stores/summaryChatStore'
import { useReceptionistStore } from '@/stores/receptionistStore'
import { useControlTranscriptStore } from '@/stores/controlTranscriptStore'
import { useNodeStore } from '@/stores/nodeStore'
import { nodeDisplayTitle } from '@/lib/node-title'
import type { NodeId } from '../shared/ids'
import { Dictation, useMicActivity, whenHearing } from './dictation'
import { useDictationSession } from './dictation-session'
import { playCue, primeCues } from './cues'
import { holdState, onHoldStateChange, setHoldMicrophone, type HoldState } from './held-microphone'
import { useHandsFree, type HandsFreePhase } from './hands-free'
import { nativeHaptic, nativeMicrophoneAvailable } from './native-microphone'
import { micLevel } from './mic-level'
import {
  LONG_PRESS_MS, conversationLeft, endPress, holdPress, lockTarget, micLook, movePress, startPress,
  type MicInputs, type MicLook, type Press,
} from './mic-button'

/**
 * The microphone, the middle of the bottom bar: one button for everything the
 * phone's microphone does, and only that. Its look is the microphone's, however
 * the listening started (mic-button.ts) — never what Control or Summary Chat is
 * doing; Control's own buttons say that.
 *
 * Tap to speak, tap again to send — to Summary Chat (`summaryChatFollowUp`),
 * or to Control while it holds the voice target or its transcript is open
 * (`nodeId` null), where what it heard shows up. Tapping while an answer is
 * playing or on its way cuts it off and starts listening, as interrupting a
 * person would; the server then forgets the part that was never heard.
 *
 * Drag up onto the lock that appears to turn hands-free on (held-microphone.ts,
 * hands-free.ts): start talking with "Control" and Control gets it without a
 * press. Drag up again to turn it off. In the app it switches as the finger
 * reaches the lock, with a tap you can feel; in a browser on letting go, since
 * only a release lets the page open a microphone.
 *
 * A long press offers to abandon Summary Chat; talking to Control, it does
 * nothing.
 *
 * A composer's dictation that is still running with the composer closed shows
 * here too, and a tap reopens a composer to stop or ship it, when
 * `onReopenComposer` is given. `talk` false: there is nothing to talk to, and
 * the button is up only for that dictation.
 */

const ERROR_SHOWN_MS = 4000
/** The conversation window's ring: its radius in a 52-unit box, inside the button's edge. */
const RING_R = 24

type Mic = { kind: 'idle' } | { kind: 'starting' } | { kind: 'listening'; dictation: Dictation } | { kind: 'sending' }

export function MicButton({ nodeId, talk = true, onReopenComposer }: {
  nodeId: NodeId | null
  talk?: boolean
  onReopenComposer?: () => void
}) {
  const toControl = useReceptionistStore((s) => s.target) || nodeId === null
  const controlPhase = useReceptionistStore((s) => s.phase)
  const summaryPhase = useSummaryChatStore((s) => (nodeId ? s.phase[nodeId] : undefined))
  /** An answer playing or on its way, which a tap cuts off. Never shown. */
  const answering = toControl ? controlPhase !== 'ready' : summaryPhase !== undefined
  const node = useNodeStore((s) => (nodeId ? s.nodes[nodeId] : undefined))
  const [mic, setMic] = useState<Mic>({ kind: 'idle' })
  const [sheet, setSheet] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [hold, setHold] = useState(holdState)
  useEffect(() => onHoldStateChange(setHold), [])
  const handsFree = useHandsFree((s) => s.phase)
  const conversation = useHandsFree((s) => s.conversation)
  const secondsLeft = useHandsFree((s) => s.secondsLeft)
  const capturing = useMicActivity((s) => s.capturing > 0)
  const transcribing = useMicActivity((s) => s.transcribing > 0)
  const composer = useDictationSession((s) => s.mic.kind)
  const look = micLook({ error: error !== null, own: mic.kind, composer, capturing, transcribing, hold, handsFree, conversation })

  const [press, setPress] = useState<Press | null>(null)
  const pressRef = useRef<Press | null>(null)
  const pressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** The press just ended was not a tap: the click that follows it is not one either. */
  const notATap = useRef(false)
  /** Hands-free already switched by this press, as the finger reached the lock. */
  const switched = useRef(false)

  // Never leave the microphone open behind a button that has gone.
  const micRef = useRef(mic)
  micRef.current = mic
  useEffect(() => () => {
    clearTimeout(pressTimer.current)
    const m = micRef.current
    if (m.kind === 'listening') m.dictation.cancel()
  }, [])

  useEffect(() => {
    if (!error) return
    const timer = setTimeout(() => setError(null), ERROR_SHOWN_MS)
    return () => clearTimeout(timer)
  }, [error])

  /** The conversation window's length: `secondsLeft` at its fullest, which it is when it opens. */
  const fullest = useRef(0)
  if (!conversation) fullest.current = 0
  else if (secondsLeft !== null) fullest.current = Math.max(fullest.current, secondsLeft)

  // The level bars, moved once a frame from the voice going out — not through
  // React, which would redraw the bar for every block of audio.
  const buttonRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (look !== 'hearing' || typeof requestAnimationFrame !== 'function') return
    let frame = requestAnimationFrame(function draw() {
      buttonRef.current?.style.setProperty('--m-level', micLevel().toFixed(3))
      frame = requestAnimationFrame(draw)
    })
    return () => cancelAnimationFrame(frame)
  }, [look])

  const fail = (cue: 'captureFailed' | 'transcriptionFailed', err: unknown) => {
    playCue(cue)
    setError(err instanceof Error ? err.message : String(err))
    setMic({ kind: 'idle' })
  }

  const listen = async () => {
    primeCues()
    setError(null)
    // A press over an answer is an interruption: stop it, then listen.
    if (answering) {
      // Stopped, not let go of: the user is about to talk to it.
      if (toControl) window.api.receptionist.stop()
      else void window.api.toggleSummaryChat(undefined, 'summary').catch(() => undefined)
    }
    setMic({ kind: 'starting' })
    try {
      // Begun here, inside the tap, or iOS will not let it record.
      const dictation = await whenHearing(Dictation.begin(window.api.dictation, { forControl: toControl }))
      setMic({ kind: 'listening', dictation })
      playCue('listeningStarted')
    } catch (err) {
      fail('captureFailed', err)
    }
  }

  const send = async (dictation: Dictation) => {
    playCue('listeningFinished')
    setMic({ kind: 'sending' })
    try {
      const text = (await dictation.finish()).trim()
      if (!text) {
        fail('transcriptionFailed', new Error("Didn't catch that — tap to try again."))
        return
      }
      if (toControl) {
        // Straight to Control, whatever the voice target has become since the
        // tap; and into its transcript, if that is open, as typing there would.
        window.api.receptionist.say(text)
        useControlTranscriptStore.getState().addPending(text)
      } else {
        window.api.summaryChatFollowUp(text)
      }
      playCue('pasted')
      setMic({ kind: 'idle' })
    } catch (err) {
      fail('transcriptionFailed', err)
    }
  }

  /** A composer's dictation still running, which a tap takes back to a composer. */
  const reopens = onReopenComposer !== undefined && composer !== 'idle' && mic.kind === 'idle'

  const onTap = () => {
    if (notATap.current) {
      notATap.current = false
      return
    }
    if (reopens) onReopenComposer()
    else if (!talk) return
    else if (mic.kind === 'idle') void listen()
    else if (mic.kind === 'listening') void send(mic.dictation)
  }

  const switchHandsFree = () => setHoldMicrophone(holdState() === 'off')

  /** Only Summary Chat has anything to offer on a long press. */
  const hasSheet = talk && !toControl

  const endOfPress = () => {
    clearTimeout(pressTimer.current)
    pressRef.current = null
    setPress(null)
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    notATap.current = false
    switched.current = false
    // The drag goes on above the button: its moves still come here.
    try { e.currentTarget.setPointerCapture?.(e.pointerId) } catch { /* not where a test runs */ }
    const started = startPress(e.clientX, e.clientY)
    pressRef.current = started
    setPress(started)
    clearTimeout(pressTimer.current)
    pressTimer.current = setTimeout(() => {
      const current = pressRef.current
      if (!current) return
      const held = holdPress(current)
      pressRef.current = held
      setPress(held)
      if (held.done === 'long' && hasSheet) setSheet(true)
    }, LONG_PRESS_MS)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const before = pressRef.current
    if (!before || before.done) return
    const moved = movePress(before, e.clientX, e.clientY)
    pressRef.current = moved
    setPress(moved)
    if (moved.done !== 'lock') return
    clearTimeout(pressTimer.current)
    nativeHaptic()
    // The app opens its own microphone; a page needs the release to.
    if (nativeMicrophoneAvailable()) {
      switched.current = true
      switchHandsFree()
    }
  }

  const onPointerUp = () => {
    const ended = pressRef.current
    endOfPress()
    if (!ended) return
    const was = endPress(ended)
    if (was !== 'tap') notATap.current = true
    if (was === 'lock' && !switched.current) switchHandsFree()
  }

  const handsFreeOn = hold !== 'off'
  const target = lockTarget(press)
  const label = micLabel({
    look, own: mic.kind, composer, handsFree, hold, secondsLeft,
    tap: reopens ? 'Still dictating — tap to open the composer and stop or ship it'
      : !talk ? 'Still dictating — open a composer to stop or ship it'
      : answering ? (toControl ? 'Cut Control off and talk' : 'Cut Summary Chat off and talk')
      : toControl ? 'Talk to Control' : 'Talk to Summary Chat',
  })

  return (
    <>
      {error && <div className="m-mic__error" role="alert">{error}</div>}
      <div className="m-mic-slot">
        {target && (
          <div className={`m-mic-lock${target.reached ? ' m-mic-lock--reached' : ''}`} style={{ '--m-lock-progress': target.progress } as CSSProperties} aria-hidden="true">
            <LockIcon open={handsFreeOn} />
            <span className="m-mic-lock__text">{handsFreeOn ? 'Stop listening' : 'Always listen'}</span>
          </div>
        )}
        <button
          ref={buttonRef}
          className={`m-mic m-mic--${look}`}
          aria-label={label}
          disabled={mic.kind === 'starting' || mic.kind === 'sending'}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={endOfPress}
          onContextMenu={(e) => e.preventDefault()}
          onClick={onTap}
        >
          {look === 'conversation' && (
            // The conversation window's quiet running out, as a ring that drains.
            <svg className="m-mic__ring" viewBox="0 0 52 52" aria-hidden="true">
              <circle cx="26" cy="26" r={RING_R} pathLength="100" strokeDasharray="100"
                strokeDashoffset={100 * (1 - conversationLeft(secondsLeft, fullest.current))} />
            </svg>
          )}
          {look === 'starting' ? '…' : look === 'hearing' ? (
            <span className="m-mic__bars" aria-hidden="true"><i /><i /><i /><i /></span>
          ) : <MicIcon locked={handsFreeOn} />}
        </button>
      </div>
      {sheet && (
        <div className="mobile-confirm m-mic-sheet" onClick={() => setSheet(false)}>
          <div className="mobile-confirm__panel" role="dialog" aria-label="Summary Chat" onClick={(e) => e.stopPropagation()}>
            <div className="m-mic__about">
              Summary Chat · {node ? nodeDisplayTitle(node) : 'surface gone'}
            </div>
            <button
              className="mobile-btn mobile-btn--danger"
              onClick={() => {
                setSheet(false)
                if (mic.kind === 'listening') mic.dictation.cancel()
                setMic({ kind: 'idle' })
                window.api.endSummaryChat()
              }}
            >
              Abandon summarizer
            </button>
          </div>
        </div>
      )}
    </>
  )
}

/** What the button is doing, what a tap does, and what dragging up does — in that order, each only when it says something. */
function micLabel({ look, own, composer, handsFree, hold, secondsLeft, tap }: {
  look: MicLook
  own: Mic['kind']
  composer: MicInputs['composer']
  handsFree: HandsFreePhase
  hold: HoldState
  secondsLeft: number | null
  tap: string
}): string {
  const app = nativeMicrophoneAvailable()
  const drag = hold !== 'off'
    ? 'drag up to stop listening'
    : app ? 'drag up to always listen for "Control"' : 'drag up to hold the microphone open with AirPods'
  switch (look) {
    case 'starting': return 'Starting the microphone'
    case 'hearing':
      if (own === 'listening') return 'Listening — tap to send'
      if (composer === 'listening') return tap
      if (handsFree === 'hearing') return 'Listening to you — stop talking to send'
      return `Your voice is being transcribed — ${drag}`
    case 'transcribing':
      if (handsFree === 'sending' && own !== 'sending') return 'Sending what you said to Control'
      return 'Transcribing'
    case 'conversation':
      return `In conversation with Control: just talk, no need to say "Control"${secondsLeft !== null ? ` — ${secondsLeft} seconds of quiet left` : ''}. ${tap}, or ${drag}`
    case 'armed':
      return app
        ? `Listening for "Control" at the start of what you say — everything else is ignored. ${tap}, or ${drag}`
        : `Microphone held open with AirPods — start talking with "Control". ${tap}, or ${drag}`
    case 'preparing':
      return `Getting the microphone ready to listen for "Control". ${tap}, or ${drag}`
    default:
      return `${tap} — ${drag}`
  }
}

function MicIcon({ locked }: { locked: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
      {locked && (
        // A small lock: hands-free holds the microphone.
        <g className="m-mic__badge">
          <rect x="16" y="15" width="7" height="6" rx="1" fill="currentColor" stroke="none" />
          <path d="M17.5 15v-1.5a2 2 0 0 1 4 0V15" strokeWidth="1.6" />
        </g>
      )}
    </svg>
  )
}

function LockIcon({ open }: { open: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d={open ? 'M8 11V7a4 4 0 0 1 7.5-2' : 'M8 11V7a4 4 0 0 1 8 0v4'} />
    </svg>
  )
}
