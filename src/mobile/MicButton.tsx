import { useEffect, useRef, useState } from 'react'
import { useReceptionistStore } from '@/stores/receptionistStore'
import { useControlTranscriptStore } from '@/stores/controlTranscriptStore'
import { Dictation, useMicActivity, whenHearing } from './dictation'
import { useDictationSession } from './dictation-session'
import { playCue, primeCues } from './cues'
import { useHoldState } from './MicLockButton'
import { useHandsFree, type HandsFreePhase } from './hands-free'
import { nativeMicrophoneAvailable } from './native-microphone'
import { micLevel } from './mic-level'
import { conversationLeft, micLook, type MicInputs, type MicLook } from './mic-button'

/**
 * The microphone, the middle of the bottom bar: one button for everything the
 * phone's microphone does, and only that. Its look is the microphone's, however
 * the listening started (mic-button.ts) — never what Control is doing; its own
 * button says that.
 *
 * Tap to speak to Control, tap again to send; what it heard shows up in the
 * transcript. Tapping while an answer is playing or on its way cuts it off and
 * starts listening, as interrupting a person would; the server then forgets
 * the part that was never heard.
 *
 * A tap and nothing else: hands-free is the lock beside it (MicLockButton.tsx).
 *
 * A composer's dictation that is still running with the composer closed shows
 * here too, and a tap reopens a composer to stop or ship it, when
 * `onReopenComposer` is given; otherwise the tap only says so.
 */

const ERROR_SHOWN_MS = 4000
/** The conversation window's ring: its radius in a 52-unit box, inside the button's edge. */
const RING_R = 24

type Mic = { kind: 'idle' } | { kind: 'starting' } | { kind: 'listening'; dictation: Dictation } | { kind: 'sending' }

export function MicButton({ onReopenComposer }: { onReopenComposer?: () => void }) {
  /** An answer playing or on its way, which a tap cuts off. Never shown. */
  const answering = useReceptionistStore((s) => s.phase !== 'ready')
  const [mic, setMic] = useState<Mic>({ kind: 'idle' })
  const [error, setError] = useState<string | null>(null)

  const hold = useHoldState()
  const handsFree = useHandsFree((s) => s.phase)
  const conversation = useHandsFree((s) => s.conversation)
  const secondsLeft = useHandsFree((s) => s.secondsLeft)
  const capturing = useMicActivity((s) => s.capturing > 0)
  const transcribing = useMicActivity((s) => s.transcribing > 0)
  const composer = useDictationSession((s) => s.mic.kind)
  const look = micLook({ error: error !== null, own: mic.kind, composer, capturing, transcribing, hold, handsFree, conversation })

  // Never leave the microphone open behind a button that has gone.
  const micRef = useRef(mic)
  micRef.current = mic
  useEffect(() => () => {
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
      window.api.receptionist.stop()
    }
    setMic({ kind: 'starting' })
    try {
      // Begun here, inside the tap, or iOS will not let it record.
      const dictation = await whenHearing(Dictation.begin(window.api.dictation, { forControl: true }))
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
      // Into its transcript, if that is open, as typing there would.
      window.api.receptionist.say(text)
      useControlTranscriptStore.getState().addPending(text)
      playCue('pasted')
      setMic({ kind: 'idle' })
    } catch (err) {
      fail('transcriptionFailed', err)
    }
  }

  /** A composer's dictation still running: a tap takes it back to a composer, if there is one to open. */
  const elsewhere = composer !== 'idle' && mic.kind === 'idle'
  const reopens = elsewhere && onReopenComposer !== undefined

  const onTap = () => {
    if (reopens) onReopenComposer()
    else if (elsewhere) return
    else if (mic.kind === 'idle') void listen()
    else if (mic.kind === 'listening') void send(mic.dictation)
  }

  const handsFreeOn = hold !== 'off'
  const label = micLabel({
    look, own: mic.kind, composer, handsFree, secondsLeft,
    tap: reopens ? 'Still dictating — tap to open the composer and stop or ship it'
      : elsewhere ? 'Still dictating — open a composer to stop or ship it'
      : answering ? 'Cut Control off and talk'
      : 'Talk to Control',
  })

  return (
    <>
      {error && <div className="m-mic__error" role="alert">{error}</div>}
      <button
        ref={buttonRef}
        className={`m-mic m-mic--${look}`}
        aria-label={label}
        disabled={mic.kind === 'starting' || mic.kind === 'sending'}
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
    </>
  )
}

/** What the button is doing, then what a tap does, when it says something. */
function micLabel({ look, own, composer, handsFree, secondsLeft, tap }: {
  look: MicLook
  own: Mic['kind']
  composer: MicInputs['composer']
  handsFree: HandsFreePhase
  secondsLeft: number | null
  tap: string
}): string {
  switch (look) {
    case 'starting': return 'Starting the microphone'
    case 'hearing':
      if (own === 'listening') return 'Listening — tap to send'
      if (composer === 'listening') return tap
      if (handsFree === 'hearing') return 'Listening to you — stop talking to send'
      return 'Your voice is being transcribed'
    case 'transcribing':
      if (handsFree === 'sending' && own !== 'sending') return 'Sending what you said to Control'
      return 'Transcribing'
    case 'conversation':
      return `In conversation with Control: just talk, no need to say "Control"${secondsLeft !== null ? ` — ${secondsLeft} seconds of quiet left` : ''}. ${tap}`
    case 'armed':
      return nativeMicrophoneAvailable()
        ? `Listening for "Control" at the start of what you say — everything else is ignored. ${tap}`
        : `Microphone held open with AirPods — start talking with "Control". ${tap}`
    case 'preparing':
      return `Getting the microphone ready to listen for "Control". ${tap}`
    default:
      return tap
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
