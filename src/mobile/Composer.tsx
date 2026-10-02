import { useEffect, useRef, useState } from 'react'
import { useNodeStore } from '@/stores/nodeStore'
import { nodeDisplayTitle } from '@/lib/node-title'
import type { NodeId } from '../shared/ids'
import { Dictation } from './dictation'
import { insertDictation } from './pcm'

/**
 * Write a prompt away from the TUI — dictate, edit, then ship it to a surface.
 *
 * Ship goes through the same server operation as a markdown card's button
 * (src/server/ship-it.ts), so a prompt lands the same way from either.
 *
 * Drafts live in this browser only, one per surface. iOS evicts a backgrounded
 * page freely, and a dictated paragraph lost to a trip to another app is the
 * failure worth designing against.
 */

const draftKey = (nodeId: NodeId) => `mobile.draft.${nodeId}`

function loadDraft(nodeId: NodeId): string {
  try { return localStorage.getItem(draftKey(nodeId)) ?? '' } catch { return '' }
}

function saveDraft(nodeId: NodeId, text: string): void {
  try {
    if (text) localStorage.setItem(draftKey(nodeId), text)
    else localStorage.removeItem(draftKey(nodeId))
  } catch { /* private mode: the draft lives as long as the page */ }
}

type MicState = { kind: 'idle' } | { kind: 'starting' } | { kind: 'listening'; dictation: Dictation } | { kind: 'transcribing' }

export function Composer({ nodeId, onClose }: { nodeId: NodeId; onClose: () => void }) {
  const node = useNodeStore((s) => s.nodes[nodeId])
  const [text, setText] = useState(() => loadDraft(nodeId))
  const [mic, setMic] = useState<MicState>({ kind: 'idle' })
  const [error, setError] = useState<string | null>(null)
  const [shipping, setShipping] = useState(false)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const cursorRef = useRef(text.length)

  useEffect(() => saveDraft(nodeId, text), [nodeId, text])

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
  useEffect(() => () => {
    const m = micRef.current
    if (m.kind === 'listening') m.dictation.cancel()
  }, [])

  const rememberCursor = () => {
    cursorRef.current = areaRef.current?.selectionStart ?? text.length
  }

  const toggleMic = async () => {
    setError(null)
    if (mic.kind === 'idle') {
      rememberCursor()
      setMic({ kind: 'starting' })
      try {
        const dictation = await Dictation.begin(window.api.dictation)
        setMic({ kind: 'listening', dictation })
      } catch (err) {
        setMic({ kind: 'idle' })
        setError(err instanceof Error ? err.message : String(err))
      }
      return
    }
    if (mic.kind !== 'listening') return
    setMic({ kind: 'transcribing' })
    try {
      const transcript = await mic.dictation.finish()
      setText((current) => {
        const next = insertDictation(current, Math.min(cursorRef.current, current.length), transcript)
        cursorRef.current = next.cursor
        return next.text
      })
    } catch (err) {
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
      setText('')
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setShipping(false)
    }
  }

  const live = node?.type === 'terminal' && node.alive
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
      <footer className="mobile-composer__actions">
        <button
          className={`mobile-btn mobile-btn--mic${mic.kind === 'listening' ? ' mobile-btn--recording' : ''}`}
          onClick={toggleMic}
          disabled={mic.kind === 'starting' || mic.kind === 'transcribing'}
        >
          {mic.kind === 'listening' && <span className="mobile-recording-dot" />}
          {micLabel}
        </button>
        <button className="mobile-btn" onClick={() => setText('')} disabled={!text}>Clear</button>
        <button
          className="mobile-btn mobile-btn--accent mobile-btn--ship"
          onClick={ship}
          disabled={!live || !text.trim() || shipping || mic.kind !== 'idle'}
          title={live ? 'Paste into the surface and submit' : 'This surface is not running'}
        >
          {shipping ? 'Shipping…' : 'Ship it'}
        </button>
      </footer>
    </div>
  )
}
