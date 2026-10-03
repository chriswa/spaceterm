import { useEffect, useRef, useState } from 'react'
import { useSummaryChatStore } from '@/stores/summaryChatStore'
import { useNodeStore } from '@/stores/nodeStore'
import { nodeDisplayTitle } from '@/lib/node-title'
import type { NodeId } from '../shared/ids'
import { Dictation, whenHearing } from './dictation'
import { playCue, primeCues } from './cues'

/**
 * The phone's way to talk to Summary Chat: what Voice Operator's command mode
 * is on the Mac. Shown while a conversation is open, over everything.
 *
 * Tap to speak, tap again to send — the words go to the same conversation a
 * voice command would (`summaryChatFollowUp`), and the answer is spoken by
 * Voice Operator as ever. Tapping while an answer is playing or on its way
 * cuts it off and starts listening, as interrupting a person would; the
 * server then forgets the part that was never heard.
 *
 * A long press offers to abandon the conversation, which takes this away.
 */

const LONG_PRESS_MS = 450
const ERROR_SHOWN_MS = 4000

type Mic = { kind: 'idle' } | { kind: 'starting' } | { kind: 'listening'; dictation: Dictation } | { kind: 'sending' }

export function SummarizerButton({ nodeId }: { nodeId: NodeId }) {
  const phase = useSummaryChatStore((s) => s.phase[nodeId])
  const node = useNodeStore((s) => s.nodes[nodeId])
  const [mic, setMic] = useState<Mic>({ kind: 'idle' })
  const [sheet, setSheet] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const longPressed = useRef(false)

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

  const fail = (cue: 'captureFailed' | 'transcriptionFailed', err: unknown) => {
    playCue(cue)
    setError(err instanceof Error ? err.message : String(err))
    setMic({ kind: 'idle' })
  }

  const listen = async () => {
    primeCues()
    setError(null)
    // A press over an answer is an interruption: stop it, then listen.
    if (phase) void window.api.toggleSummaryChat(undefined, 'summary').catch(() => undefined)
    setMic({ kind: 'starting' })
    try {
      // Begun here, inside the tap, or iOS will not let it record.
      const dictation = await whenHearing(Dictation.begin(window.api.dictation))
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
      window.api.summaryChatFollowUp(text)
      playCue('pasted')
      setMic({ kind: 'idle' })
    } catch (err) {
      fail('transcriptionFailed', err)
    }
  }

  const onTap = () => {
    if (longPressed.current) {
      longPressed.current = false
      return
    }
    if (mic.kind === 'idle') void listen()
    else if (mic.kind === 'listening') void send(mic.dictation)
  }

  const abandon = () => {
    setSheet(false)
    if (mic.kind === 'listening') mic.dictation.cancel()
    setMic({ kind: 'idle' })
    window.api.endSummaryChat()
  }

  const state = mic.kind !== 'idle' ? mic.kind : phase ?? 'ready'
  const label = {
    ready: 'Talk to Summary Chat',
    starting: 'Starting the microphone',
    listening: 'Listening — tap to send',
    sending: 'Transcribing',
    thinking: 'Thinking — tap to interrupt and talk',
    synthesizing: 'About to speak — tap to interrupt and talk',
    speaking: 'Speaking — tap to interrupt and talk'
  }[state]

  return (
    <>
      {error && <div className="m-summarizer__error" role="alert">{error}</div>}
      <button
        className={`m-summarizer m-summarizer--${state}`}
        aria-label={label}
        disabled={mic.kind === 'starting' || mic.kind === 'sending'}
        onPointerDown={() => {
          longPressed.current = false
          clearTimeout(pressTimer.current)
          pressTimer.current = setTimeout(() => {
            longPressed.current = true
            setSheet(true)
          }, LONG_PRESS_MS)
        }}
        onPointerUp={() => clearTimeout(pressTimer.current)}
        onPointerCancel={() => clearTimeout(pressTimer.current)}
        onPointerLeave={() => clearTimeout(pressTimer.current)}
        onContextMenu={(e) => e.preventDefault()}
        onClick={onTap}
      >
        {mic.kind === 'starting' || mic.kind === 'sending' ? '…' : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0" />
            <path d="M12 18v3" />
          </svg>
        )}
      </button>
      {sheet && (
        <div className="mobile-confirm m-summarizer-sheet" onClick={() => setSheet(false)}>
          <div className="mobile-confirm__panel" role="dialog" aria-label="Summary Chat" onClick={(e) => e.stopPropagation()}>
            <div className="m-summarizer__about">Summary Chat · {node ? nodeDisplayTitle(node) : 'surface gone'}</div>
            <button className="mobile-btn mobile-btn--danger" onClick={abandon}>
              Abandon summarizer
            </button>
          </div>
        </div>
      )}
    </>
  )
}
