import { useEffect, useMemo, useRef, useState } from 'react'
import { useNodeStore } from '@/stores/nodeStore'
import { nodeDisplayTitle } from '@/lib/node-title'
import type { NodeId } from '../shared/ids'
import { Dictation } from './dictation'
import { insertDictation } from './pcm'
import { nextRecall, promptStore } from './prompt-store'
import { playCue, primeCues } from './cues'

/**
 * Write a prompt away from the TUI — dictate, edit, then ship it to a surface.
 *
 * Ship goes through the same server operation as a markdown card's button
 * (src/server/ship-it.ts), so a prompt lands the same way from either.
 *
 * Drafts live in this browser only, one per surface (see prompt-store.ts).
 * iOS evicts a backgrounded page freely, and a dictated paragraph lost to a
 * trip to another app is the failure worth designing against. A shipped
 * prompt leaves the draft at once, into a history the recall button walks back
 * through.
 */

/** A button press that must not take focus from the text (and so dismiss the keyboard). */
const keepFocus = (e: { preventDefault(): void }) => e.preventDefault()

type MicState = { kind: 'idle' } | { kind: 'starting' } | { kind: 'listening'; dictation: Dictation } | { kind: 'transcribing' }

export function Composer({ nodeId, onClose, startDictation }: {
  nodeId: NodeId
  onClose: () => void
  /**
   * Listening already begun by the tap that opened this — it has to start
   * inside that tap, or iOS will not let it record. Dictating is what the
   * composer opens into.
   */
  startDictation?: Promise<Dictation> | null
}) {
  const node = useNodeStore((s) => s.nodes[nodeId])
  const store = useMemo(() => promptStore(nodeId), [nodeId])
  const [text, setTextState] = useState(() => store.draft())
  const [history, setHistory] = useState(() => store.history())
  const [mic, setMic] = useState<MicState>({ kind: 'idle' })
  const [error, setError] = useState<string | null>(null)
  const [shipping, setShipping] = useState(false)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const cursorRef = useRef(text.length)

  /** Change the text and save it in the same breath; see prompt-store.ts for why not later. */
  const setText = (next: string) => {
    store.setDraft(next)
    setTextState(next)
  }

  // Arrive ready to type, cursor at the end of the draft. The tap that opened
  // this already raised the keyboard (see MobileApp's keeper); this moves it here.
  useEffect(() => {
    const area = areaRef.current
    if (!area) return
    area.focus()
    area.setSelectionRange(area.value.length, area.value.length)
  }, [])

  // Leaving with the mic open throws the audio away rather than leaking it.
  const micRef = useRef(mic)
  micRef.current = mic
  const closedRef = useRef(false)
  useEffect(() => () => {
    closedRef.current = true
    const m = micRef.current
    if (m.kind === 'listening') m.dictation.cancel()
  }, [])

  const rememberCursor = () => {
    cursorRef.current = areaRef.current?.selectionStart ?? text.length
  }

  /** Voice Operator's cues throughout: started, finished, pasted — and its failure tones. */
  const listen = async (pending: Promise<Dictation>) => {
    setError(null)
    rememberCursor()
    setMic({ kind: 'starting' })
    try {
      const dictation = await pending
      if (closedRef.current) {
        dictation.cancel()
        return
      }
      setMic({ kind: 'listening', dictation })
      // As on the desktop, the start cue means "safe to talk": it plays only
      // once the microphone is live.
      playCue('listeningStarted')
    } catch (err) {
      setMic({ kind: 'idle' })
      playCue('captureFailed')
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  // Open straight into dictation when the tap that opened us started it.
  const startedRef = useRef(false)
  useEffect(() => {
    if (startedRef.current || !startDictation) return
    startedRef.current = true
    void listen(startDictation)
  }, [startDictation])

  const toggleMic = async () => {
    if (mic.kind === 'idle') {
      primeCues()
      void listen(Dictation.begin(window.api.dictation))
      return
    }
    if (mic.kind !== 'listening') return
    playCue('listeningFinished')
    setMic({ kind: 'transcribing' })
    try {
      const transcript = await mic.dictation.finish()
      const current = areaRef.current?.value ?? text
      const next = insertDictation(current, Math.min(cursorRef.current, current.length), transcript)
      cursorRef.current = next.cursor
      if (next.text !== current) {
        setText(next.text)
        playCue('pasted')
      }
    } catch (err) {
      playCue('transcriptionFailed')
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setMic({ kind: 'idle' })
    }
  }

  const ship = async () => {
    if (!text.trim() || shipping) return
    setShipping(true)
    setError(null)
    try {
      await window.api.node.shipIt(nodeId, text)
      store.shipped(text)
      setTextState('')
      setHistory(store.history())
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setShipping(false)
    }
  }

  const live = node?.type === 'terminal' && node.alive
  const recall = nextRecall(text, history)
  const micLabel = mic.kind === 'listening' ? 'Stop' : mic.kind === 'starting' ? '…' : mic.kind === 'transcribing' ? 'Transcribing…' : 'Dictate'

  return (
    <div className="mobile-composer" role="dialog" aria-label="Compose a prompt">
      <header className="mobile-term__bar">
        <button className="mobile-btn" onClick={onClose}>‹ Terminal</button>
        <span className="mobile-term__title">To: {node ? nodeDisplayTitle(node) : 'surface gone'}</span>
      </header>
      <textarea
        ref={areaRef}
        className="mobile-composer__text"
        value={text}
        placeholder="Dictate or type, edit, then ship it to the surface."
        onChange={(e) => {
          setText(e.target.value)
          cursorRef.current = e.target.selectionStart
        }}
        onSelect={rememberCursor}
        autoCorrect="on"
        autoCapitalize="sentences"
      />
      {error && <div className="mobile-composer__error" role="alert">{error}</div>}
      {/* Directly above the keyboard, and fixed there: see .mobile-composer. */}
      <div className="mobile-composer__actions">
        <button className="mobile-btn" onMouseDown={keepFocus} onClick={() => setText('')} disabled={!text}>Clear</button>
        <button
          className="mobile-btn mobile-btn--icon"
          onMouseDown={keepFocus}
          onClick={() => { if (recall !== null) setText(recall) }}
          disabled={recall === null}
          aria-label="Bring back a prompt already sent"
          title="Bring back a prompt already sent"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 4 2.5 7.5 6 11" />
            <path d="M2.5 7.5h8a4.5 4.5 0 0 1 0 9H8" />
          </svg>
        </button>
        <button
          className={`mobile-btn mobile-btn--mic${mic.kind === 'listening' ? ' mobile-btn--recording' : ''}`}
          onMouseDown={keepFocus}
          onClick={toggleMic}
          disabled={mic.kind === 'starting' || mic.kind === 'transcribing'}
        >
          {mic.kind === 'listening' && <span className="mobile-recording-dot" />}
          {micLabel}
        </button>
        <button
          className="mobile-btn mobile-btn--accent mobile-btn--ship"
          onClick={ship}
          disabled={!live || !text.trim() || shipping || mic.kind !== 'idle'}
          title={live ? 'Paste into the surface and submit' : 'This surface is not running'}
        >
          {shipping ? 'Shipping…' : 'Ship it'}
        </button>
      </div>
    </div>
  )
}
