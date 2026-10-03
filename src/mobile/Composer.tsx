import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNodeStore } from '@/stores/nodeStore'
import { nodeDisplayTitle } from '@/lib/node-title'
import type { NodeId } from '../shared/ids'
import { Dictation, whenHearing } from './dictation'
import { insertDictation } from './pcm'
import { promptStore } from './prompt-store'
import { playCue, primeCues } from './cues'
import { deleteWordBefore } from './text-edit'
import { TerminalGesture } from './terminal-gesture'
import { handTouchToCanvas } from '@/hooks/useTouchCamera'

/**
 * Write a prompt away from the TUI — dictate, edit, then ship it to a surface.
 *
 * Ship goes through the same server operation as a markdown card's button
 * (src/server/ship-it.ts), so a prompt lands the same way from either.
 *
 * Drafts live in this browser only, one per surface (see prompt-store.ts).
 * iOS evicts a backgrounded page freely, and a dictated paragraph lost to a
 * trip to another app is the failure worth designing against. Shipping or
 * clearing moves the draft into a history the ✕ sheet can restore from.
 */

/** A button press that must not take focus from the text (and so dismiss the keyboard). */
const keepFocus = (e: { preventDefault(): void }) => e.preventDefault()

type MicState = { kind: 'idle' } | { kind: 'starting' } | { kind: 'listening'; dictation: Dictation } | { kind: 'transcribing' }

export function Composer({ nodeId, onClose, onExitToCanvas, startDictation }: {
  nodeId: NodeId
  /** Back to the terminal. */
  onClose: () => void
  /** All the way back to the canvas — a sideways swipe, as in the terminal view. */
  onExitToCanvas: () => void
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
  const [clearSheet, setClearSheet] = useState(false)
  const [swipeDx, setSwipeDx] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const cursorRef = useRef(text.length)
  /** Where to put the caret once a programmatic edit has rendered. */
  const pendingCaretRef = useRef<number | null>(null)

  /** Change the text and save it in the same breath; see prompt-store.ts for why not later. */
  const setText = (next: string, caret?: number) => {
    store.setDraft(next)
    setTextState(next)
    if (caret !== undefined) {
      cursorRef.current = caret
      pendingCaretRef.current = caret
    }
  }

  useLayoutEffect(() => {
    const caret = pendingCaretRef.current
    const area = areaRef.current
    if (caret === null || !area) return
    pendingCaretRef.current = null
    area.setSelectionRange(caret, caret)
  }, [text])

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
      // As on the desktop, the start cue means "safe to talk": it plays only
      // once sound is actually arriving (see whenHearing).
      const dictation = await whenHearing(pending)
      if (closedRef.current) {
        dictation.cancel()
        return
      }
      setMic({ kind: 'listening', dictation })
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

  /** Stop listening and put what was said at the caret. Resolves to the text afterwards. */
  const finishDictation = async (dictation: Dictation): Promise<string> => {
    playCue('listeningFinished')
    setMic({ kind: 'transcribing' })
    const current = areaRef.current?.value ?? text
    try {
      const transcript = await dictation.finish()
      const next = insertDictation(current, Math.min(cursorRef.current, current.length), transcript)
      if (next.text !== current) {
        setText(next.text, next.cursor)
        playCue('pasted')
      }
      return next.text
    } catch (err) {
      playCue('transcriptionFailed')
      setError(err instanceof Error ? err.message : String(err))
      return current
    } finally {
      setMic({ kind: 'idle' })
    }
  }

  const toggleMic = () => {
    if (mic.kind === 'idle') {
      primeCues()
      void listen(Dictation.begin(window.api.dictation))
    } else if (mic.kind === 'listening') {
      void finishDictation(mic.dictation)
    }
  }

  /** Ship — finishing a dictation in progress first, so what was being said goes too. */
  const ship = async () => {
    if (shipping) return
    setShipping(true)
    setError(null)
    try {
      const outgoing = mic.kind === 'listening' ? await finishDictation(mic.dictation) : text
      if (!outgoing.trim()) return
      await window.api.node.shipIt(nodeId, outgoing)
      store.shipped(outgoing)
      setTextState('')
      setHistory(store.history())
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setShipping(false)
    }
  }

  const deleteWord = () => {
    const area = areaRef.current
    const caret = area?.selectionStart ?? cursorRef.current
    const next = deleteWordBefore(text, caret)
    if (next.text !== text) setText(next.text, next.cursor)
  }

  // The previous content the ✕ sheet can bring back: the newest thing shipped
  // or cleared that is not what the composer already holds.
  const previous = history.find((t) => t !== text) ?? null

  const clearAll = () => {
    store.cleared(text)
    setTextState('')
    cursorRef.current = 0
    setHistory(store.history())
    setClearSheet(false)
  }

  const restorePrevious = () => {
    if (previous === null) return
    // Whatever is there now is kept the same way, so restoring loses nothing.
    if (text) store.cleared(text)
    setText(previous, previous.length)
    setHistory(store.history())
    setClearSheet(false)
  }

  // Sideways swipe back to the canvas, as in the terminal view. Only watched,
  // never prevented, so typing, scrolling and selecting text are untouched.
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const g = new TerminalGesture()
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 1) g.begin(e.touches[0].clientX, e.touches[0].clientY, e.timeStamp)
    }
    const onMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return
      const move = g.move(e.touches[0].clientX, e.touches[0].clientY)
      if (move.kind === 'swipe') setSwipeDx(move.dx)
      else if (move.kind === 'exit') {
        // Leave as it gets far enough; the rest of the drag pans the canvas.
        onExitToCanvas()
        handTouchToCanvas(e)
      }
    }
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length > 0) return
      setSwipeDx(0)
      if (g.end(e.timeStamp) === 'exit') onExitToCanvas()
    }
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: true })
    el.addEventListener('touchend', onEnd, { passive: true })
    el.addEventListener('touchcancel', onEnd, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
  }, [onExitToCanvas])

  const live = node?.type === 'terminal' && node.alive
  const micLabel = mic.kind === 'listening' ? 'Stop' : mic.kind === 'starting' ? '…' : mic.kind === 'transcribing' ? 'Transcribing…' : 'Dictate'
  const canShip = live && !shipping && (mic.kind === 'listening' || (mic.kind === 'idle' && text.trim() !== ''))

  return (
    <div
      ref={rootRef}
      className="mobile-composer"
      role="dialog"
      aria-label="Compose a prompt"
      style={swipeDx ? { transform: `translateX(${swipeDx}px)`, opacity: Math.max(0.4, 1 - Math.abs(swipeDx) / 300) } : undefined}
    >
      <header className="mobile-term__bar">
        <button className="mobile-btn" onClick={onClose}>‹ Terminal</button>
        <span className="mobile-term__title">To: {node ? nodeDisplayTitle(node) : 'surface gone'}</span>
      </header>
      <textarea
        ref={areaRef}
        className="mobile-composer__text"
        value={text}
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
        <button
          className="mobile-btn mobile-btn--icon"
          onMouseDown={keepFocus}
          onClick={() => setClearSheet(true)}
          disabled={!text && previous === null}
          aria-label="Clear, or restore previous content"
        >
          ✕
        </button>
        <button
          className="mobile-btn mobile-btn--icon"
          onMouseDown={keepFocus}
          onClick={deleteWord}
          disabled={!text}
          aria-label="Delete the word before the cursor"
        >
          ^W
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
          onMouseDown={keepFocus}
          onClick={ship}
          disabled={!canShip}
          title={live ? 'Paste into the surface and submit' : 'This surface is not running'}
        >
          {shipping ? 'Shipping…' : 'Ship it'}
        </button>
      </div>
      {clearSheet && (
        <div className="mobile-confirm" onClick={() => setClearSheet(false)}>
          <div className="mobile-confirm__panel" role="dialog" aria-label="Clear or restore" onClick={(e) => e.stopPropagation()}>
            <button className="mobile-btn mobile-btn--danger" onMouseDown={keepFocus} onClick={clearAll} disabled={!text}>
              Clear all
            </button>
            <button className="mobile-btn" onMouseDown={keepFocus} onClick={restorePrevious} disabled={previous === null}>
              {previous === null ? 'Nothing to restore' : `Restore previous · ${previous.length} characters`}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
