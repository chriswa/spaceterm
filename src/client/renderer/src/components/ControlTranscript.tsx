import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ControlTranscriptEntry } from '../../../../shared/protocol'
import { useControlTranscriptStore } from '../stores/controlTranscriptStore'
import { useReceptionistStore } from '../stores/receptionistStore'
import { classifyWheelEvent, createWheelAccumulator } from '../lib/wheel-gesture'
import { TRANSCRIPT_DISMISS_SCROLL_THRESHOLD } from '../lib/constants'

/**
 * Control's transcript: the whole conversation with the receptionist, from
 * its full record — never what compaction left of it — and a box to type to
 * it, beside the microphone. Opens at the newest, at the bottom, and loads
 * older entries as you scroll up. A dialog over the canvas on the desktop
 * (`modal`), the whole screen on the phone (`screen`).
 */

/** Within this many pixels of the top, the next page loads. */
const LOAD_OLDER_PX = 400
/** Within this many pixels of the bottom, new content keeps the view at the bottom. */
const STICK_PX = 80
/** Further than this from the bottom, the button that goes back there shows. */
const AT_BOTTOM_PX = 8

/** Entries from both pages and live appends, each once, oldest first. */
export function mergeEntries(have: readonly ControlTranscriptEntry[], added: readonly ControlTranscriptEntry[]): ControlTranscriptEntry[] {
  const byOffset = new Map<number, ControlTranscriptEntry>()
  for (const entry of have) byOffset.set(entry.offset, entry)
  for (const entry of added) byOffset.set(entry.offset, entry)
  return [...byOffset.values()].sort((a, b) => a.offset - b.offset)
}

/**
 * Marks the buttons that open and close the transcript themselves (the Mac's
 * Control and transcript buttons): a press on one is not a click outside the
 * dialog, or the dialog would close on the press and reopen on the click.
 */
export const TRANSCRIPT_TOGGLE_ATTR = 'data-control-transcript-toggle'

/**
 * The desktop dialog closes like a modal: a press anywhere outside it, or a
 * decisive sideways scroll anywhere (the same classifier that lets a sideways
 * swipe leave a focused terminal, at a higher threshold).
 *
 * A press on the backdrop over the canvas is the backdrop's own to handle (see
 * below), so the canvas never sees it; a press elsewhere — the toolbar — closes
 * the dialog and still does what it was for.
 */
function useModalDismiss(enabled: boolean, dialogRef: React.RefObject<HTMLDivElement>, onDismiss: () => void): void {
  // Read through a ref: callers pass a fresh arrow each render, and
  // resubscribing would reset the sideways-scroll tally mid-gesture.
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss
  useEffect(() => {
    if (!enabled) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null
      if (!target || dialogRef.current?.contains(target)) return
      if (target.closest(`.control-transcript-backdrop, [${TRANSCRIPT_TOGGLE_ATTR}]`)) return
      dismiss.current()
    }
    const acc = createWheelAccumulator()
    const onWheel = (e: WheelEvent) => {
      if (classifyWheelEvent(acc, e, TRANSCRIPT_DISMISS_SCROLL_THRESHOLD) === 'horizontal') dismiss.current()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('wheel', onWheel, { capture: true, passive: true })
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('wheel', onWheel, { capture: true })
    }
  }, [enabled, dialogRef])
}

/** How to put the scroll back once new entries are drawn. */
type Restore = 'bottom' | { fromBottom: number }

export function ControlTranscript({ variant, onDismiss }: { variant: 'modal' | 'screen'; onDismiss: () => void }) {
  const [entries, setEntries] = useState<ControlTranscriptEntry[]>([])
  const [more, setMore] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const pending = useControlTranscriptStore((s) => s.pending)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const loading = useRef(false)
  const restore = useRef<Restore | null>(null)
  /** Near enough the bottom to be kept there as content arrives: see the ResizeObserver below. */
  const stick = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  /** Control's thinking cue is playing: a circle at the bottom goes round with it. */
  const thinking = useReceptionistStore((s) => s.phase === 'thinking')
  const contentRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  useModalDismiss(variant === 'modal', dialogRef, onDismiss)

  /** The newest page when `before` is undefined, else the page before that offset. */
  const load = useCallback(async (before: number | undefined) => {
    if (loading.current) return
    loading.current = true
    try {
      const page = await window.api.receptionist.transcript(before)
      const list = listRef.current
      // Older entries go in above: keep what is on screen where it is.
      restore.current = before === undefined || !list ? 'bottom' : { fromBottom: list.scrollHeight - list.scrollTop }
      setEntries((have) => mergeEntries(have, page.entries))
      setMore(page.more)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      loading.current = false
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    // Subscribed before the first page is asked for, so nothing recorded in between is missed.
    const off = window.api.receptionist.onTranscriptAppended((added) => {
      setEntries((have) => mergeEntries(have, added))
      useControlTranscriptStore.getState().settle(added)
    })
    void load(undefined)
    return off
  }, [load])

  useEffect(() => {
    // The phone's keyboard would cover half the transcript before it is read.
    if (variant === 'modal') inputRef.current?.focus()
  }, [variant])

  // Something just sent — typed here, or spoken into the phone's talk button —
  // takes the reader to the bottom and keeps them there, so the thinking
  // circle and the reply come into view as they arrive.
  const pendingCount = useRef(pending.length)
  if (pending.length > pendingCount.current) {
    restore.current = 'bottom'
    stick.current = true
  }
  pendingCount.current = pending.length

  useLayoutEffect(() => {
    const list = listRef.current
    const how = restore.current
    restore.current = null
    if (!list || !how) return
    list.scrollTop = how === 'bottom' ? list.scrollHeight : list.scrollHeight - how.fromBottom
  }, [entries, pending])

  // Whatever grows the content — an entry, a struck-out reply, the thinking
  // circle, a log line opened — or shrinks the view, as the keyboard does,
  // keeps a reader at the bottom there.
  useEffect(() => {
    const list = listRef.current
    const content = contentRef.current
    if (!list || !content) return
    const follow = new ResizeObserver(() => {
      if (stick.current) list.scrollTop = list.scrollHeight
    })
    follow.observe(content)
    follow.observe(list)
    return () => follow.disconnect()
  }, [])

  const scrollToBottom = () => {
    const list = listRef.current
    if (!list) return
    stick.current = true
    list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' })
  }

  const loadOlderIfNearTop = useCallback(() => {
    const list = listRef.current
    if (!list || !more || entries.length === 0) return
    if (list.scrollTop < LOAD_OLDER_PX) void load(entries[0].offset)
  }, [more, entries, load])

  // A page too short to scroll can never be scrolled up: keep loading until it can.
  useEffect(loadOlderIfNearTop, [loadOlderIfNearTop])

  // Marks of how much of a cut-off reply was heard are not entries of their own: they strike out the rest of the reply they name.
  const heard = new Map<number, number[]>()
  for (const entry of entries) if (entry.kind === 'heard') heard.set(entry.of, entry.parts)
  const shown = entries.filter((entry) => entry.kind !== 'heard')

  const send = () => {
    const text = draft.trim()
    if (!text) return
    window.api.receptionist.say(text)
    useControlTranscriptStore.getState().addPending(text)
    setDraft('')
    inputRef.current?.focus()
  }

  const dialog = (
    <div
      ref={dialogRef}
      className={`control-transcript control-transcript--${variant}`}
      role="dialog"
      aria-modal={variant === 'modal' || undefined}
      aria-label="Control"
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        onDismiss()
      }}
    >
      <div className="control-transcript__body">
        <div
          className="control-transcript__list"
          ref={listRef}
          onScroll={() => {
            const list = listRef.current!
            const fromBottom = list.scrollHeight - list.scrollTop - list.clientHeight
            stick.current = fromBottom < STICK_PX
            setAtBottom(fromBottom <= AT_BOTTOM_PX)
            loadOlderIfNearTop()
          }}
        >
          <div className="control-transcript__content" ref={contentRef}>
            {more
              ? <div className="control-transcript__edge">Loading earlier…</div>
              : loaded && <div className="control-transcript__edge">{entries.length ? 'The start of the conversation' : 'Nothing said to Control yet'}</div>}
            {shown.map((entry, i) => (
              <EntryRow key={entry.offset} entry={entry} previous={shown[i - 1]} heard={heard.get(entry.offset)} />
            ))}
            {pending.map((text, i) => (
              <div key={`pending-${i}`} className="control-transcript__entry control-transcript__entry--user control-transcript__entry--pending">
                <div className="control-transcript__bubble">{text}</div>
              </div>
            ))}
            {thinking && (
              <div className="control-transcript__thinking" role="status" aria-label="Control is thinking">
                <span className="control-transcript__spinner" />
              </div>
            )}
          </div>
        </div>
        {!atBottom && (
          <button className="control-transcript__to-bottom" aria-label="Scroll to the newest" onClick={scrollToBottom}>
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 3v10" />
              <path d="M3.5 8.5 8 13l4.5-4.5" />
            </svg>
          </button>
        )}
      </div>
      {error && <div className="control-transcript__error" role="alert">{error}</div>}
      <form
        className="control-transcript__composer"
        onSubmit={(e) => { e.preventDefault(); send() }}
      >
        <textarea
          ref={inputRef}
          className="control-transcript__input"
          placeholder="Message Control"
          rows={Math.min(6, draft.split('\n').length)}
          value={draft}
          enterKeyHint="send"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
        />
        <button className="control-transcript__send" type="submit" disabled={!draft.trim()}>Send</button>
      </form>
    </div>
  )
  if (variant !== 'modal') return dialog
  // A click on the canvas around the dialog closes it and goes no further: the
  // canvas under the backdrop neither pans nor loses its focused card.
  return (
    <>
      <div
        className="control-transcript-backdrop"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onDismiss() }}
      />
      {dialog}
    </>
  )
}

function day(timestamp: string): string {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
}

function time(timestamp: string): string {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** `heard`: how much of each part of this reply was heard, when it was cut off. */
function EntryRow({ entry, previous, heard }: { entry: ControlTranscriptEntry; previous?: ControlTranscriptEntry; heard?: number[] }) {
  if (entry.kind === 'heard') return null
  const today = day(entry.timestamp)
  const divider = today && today !== (previous ? day(previous.timestamp) : '')
    ? <div className="control-transcript__day">{today}</div>
    : null
  const at = time(entry.timestamp)
  if (entry.kind === 'log') {
    // What Control did, in full, is detail: one line until opened.
    const colon = entry.text.indexOf(': ')
    const head = colon < 0 ? entry.text : entry.text.slice(0, colon)
    // Never ran: the user cut off the words it waited on. Struck out, as those words are.
    const notDone = entry.notDone === true
    return (
      <>
        {divider}
        <details
          className={`control-transcript__entry control-transcript__entry--log${notDone ? ' control-transcript__entry--not-done' : ''}`}
          // The verb picks the pill's colour: SENT, STARTED, ARCHIVED, …
          data-action={entry.text.split(' ')[0].toLowerCase()}
          title={notDone ? `Not done: you cut Control off before it said so · ${at}` : at}
        >
          <summary>{notDone ? <><s>{head}</s> · not done, cut off</> : head}</summary>
          {colon >= 0 && <div className="control-transcript__log-body">{entry.text.slice(colon + 2)}</div>}
        </details>
      </>
    )
  }
  if (entry.kind === 'user') {
    return (
      <>
        {divider}
        <div className="control-transcript__entry control-transcript__entry--user">
          {entry.context && (
            <details className="control-transcript__context">
              <summary>What Control was told with this</summary>
              <div>{entry.context}</div>
            </details>
          )}
          <div className="control-transcript__bubble" title={at}>{entry.text}</div>
          <div className="control-transcript__meta">You · {at}</div>
        </div>
      </>
    )
  }
  return (
    <>
      {divider}
      <div className="control-transcript__entry control-transcript__entry--reply">
        {entry.parts.length === 0 && <div className="control-transcript__silent">Control said nothing</div>}
        {entry.parts.map((part, i) => (
          <div key={i} className="control-transcript__part">
            {/* Every change of voice is headed, so each block says who spoke it. */}
            {(i === 0 || part.from !== entry.parts[i - 1].from) && (
              <div className="control-transcript__meta">{part.from}{i === 0 ? ` · ${at}` : ''}</div>
            )}
            <div className="control-transcript__bubble"><HeardText text={part.text} heard={heard?.[i]} /></div>
          </div>
        ))}
      </div>
    </>
  )
}

/** A part of a reply, the part the user never heard struck out: they talked over it, or Control cut itself off. */
function HeardText({ text, heard }: { text: string; heard?: number }) {
  if (heard === undefined || heard >= text.length) return <>{text}</>
  return (
    <>
      {text.slice(0, heard)}
      <s className="control-transcript__unheard" title="Not heard: cut off">{text.slice(heard)}</s>
    </>
  )
}
