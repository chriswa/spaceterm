import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ControlTranscriptEntry } from '../../../../shared/protocol'
import { useControlTranscriptStore } from '../stores/controlTranscriptStore'
import { useReceptionistStore } from '../stores/receptionistStore'
import { classifyWheelEvent, createWheelAccumulator } from '../lib/wheel-gesture'
import { TRANSCRIPT_DISMISS_SCROLL_THRESHOLD } from '../lib/constants'
import { openReplies, partViews, segments, words, type PartView } from '../lib/control-consumption'

/**
 * Control's transcript: the whole conversation with the receptionist, from
 * its full record — never what compaction left of it — and a box to type to
 * it, beside the microphone. Opens at the newest, at the bottom — or at the
 * first reply not read yet, when Control was muted — and loads older entries
 * as you scroll up. A dialog over the canvas on the desktop (`modal`), the
 * whole screen on the phone (`screen`).
 *
 * Its footer, under the box to type in, says where Control speaks, and moves
 * it: here, muted here, or let go. Words the user missed are struck out, and words still waiting for
 * them sit under a red Unread line until they mark them read or send their
 * next message (see `ConsumptionLedger.settle`): nothing counts as read for
 * being on screen. Until then, clicking a word of what Control has said since
 * their last message marks everything up to it taken in and the rest missed,
 * as many times as they like. As the voice goes, what it has yet to say is dim.
 * Any part can be played again in its own voice.
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
 * Control button): a press on one is not a click outside the
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

/** How to put the scroll back once new entries are drawn: at the bottom, as far from it as before, or with an entry at the top. */
type Restore = 'bottom' | { fromBottom: number } | { toOffset: number }

/** Room left above the first unread entry when the view opens on it. */
const UNREAD_MARGIN_PX = 8

/**
 * `controlsExtra` goes at the end of the footer: the phone's earpiece switch.
 */
export function ControlTranscript({ variant, onDismiss, controlsExtra }: { variant: 'modal' | 'screen'; onDismiss: () => void; controlsExtra?: ReactNode }) {
  const [entries, setEntries] = useState<ControlTranscriptEntry[]>([])
  const [more, setMore] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const pending = useControlTranscriptStore((s) => s.pending)
  const reasoning = useControlTranscriptStore((s) => s.reasoning)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const loading = useRef(false)
  const restore = useRef<Restore | null>(null)
  /** Near enough the bottom to be kept there as content arrives: see the ResizeObserver below. */
  const stick = useRef(true)
  /** Where the last scroll event found the list, to tell a reader scrolling up from content growing under them. */
  const lastScrollTop = useRef(0)
  const [atBottom, setAtBottom] = useState(true)
  /** Control's thinking cue is playing: a circle at the bottom goes round with it. */
  const thinking = useReceptionistStore((s) => s.phase === 'thinking')
  const contentRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  useModalDismiss(variant === 'modal', dialogRef, onDismiss)
  /** The oldest reply with words waiting when the view opened: the view opens on it. */
  const [firstUnread] = useState(() => useReceptionistStore.getState().unread.first)
  /** The part this device is replaying, if any. */
  const [replaying, setReplaying] = useState<{ of: number; part: number } | null>(null)
  useEffect(() => window.api.receptionist.onReplaying((playing, refused) => {
    setReplaying(playing)
    if (refused) setError(`Could not play that again: ${refused}.`)
  }), [])
  /** How far Control's voice has got through the reply it is saying, if any. */
  const [speaking, setSpeaking] = useState<{ of: number; parts: number[] } | null>(null)
  useEffect(() => window.api.receptionist.onSpeaking(setSpeaking), [])
  const voicing = useReceptionistStore((s) => s.phase === 'speaking' || s.phase === 'synthesizing')
  const unread = useReceptionistStore((s) => s.unread.count)

  /** The newest page when `before` is undefined, else the page before that offset. */
  const load = useCallback(async (before: number | undefined) => {
    if (loading.current) return
    loading.current = true
    try {
      const page = await window.api.receptionist.transcript(before)
      const list = listRef.current
      // Older entries go in above: keep what is on screen where it is. Opening
      // on unread replies starts at the first of them, if this page has it.
      const opening = before === undefined && firstUnread !== undefined && page.entries.some((entry) => entry.offset === firstUnread)
      restore.current = opening ? { toOffset: firstUnread } : before === undefined || !list ? 'bottom' : { fromBottom: list.scrollHeight - list.scrollTop }
      if (opening) stick.current = false
      setEntries((have) => mergeEntries(have, page.entries))
      setMore(page.more)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      loading.current = false
      setLoaded(true)
    }
  }, [firstUnread])

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
    if (how === 'bottom') list.scrollTop = list.scrollHeight
    else if ('fromBottom' in how) list.scrollTop = list.scrollHeight - how.fromBottom
    else {
      const entry = list.querySelector(`[data-entry-offset="${how.toOffset}"]`)
      if (entry) list.scrollTop += entry.getBoundingClientRect().top - list.getBoundingClientRect().top - UNREAD_MARGIN_PX
    }
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

  // Marks of what was heard or read of a reply are not entries of their own: they say what of it the user missed.
  const views = partViews(entries)
  // Control's reasoning only when asked for: most of the time it is the conversation that matters.
  // A failed turn is always shown: Control said so out loud, and the error is the only account of why.
  const shown = entries.filter((entry) => entry.kind !== 'heard' && entry.kind !== 'consumed' &&
    (reasoning || entry.kind !== 'trace' || entry.what === 'failed'))
  // What the user can still mark: not while the voice decides, nor once their next message is on its way.
  const markable = voicing || pending.length ? new Set<number>() : openReplies(entries, !more)
  const firstWaiting = shown.find((entry) => views.get(entry.offset)?.some((part) => part.why === 'waiting'))?.offset

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
            // Only the reader scrolling up lets go of the bottom. A scroll event
            // can land after the content has grown again — iOS dispatches them
            // late — and would otherwise read a long message still arriving as
            // the reader having left.
            if (fromBottom < STICK_PX) stick.current = true
            else if (list.scrollTop < lastScrollTop.current) stick.current = false
            lastScrollTop.current = list.scrollTop
            setAtBottom(fromBottom <= AT_BOTTOM_PX)
            loadOlderIfNearTop()
          }}
        >
          <div className="control-transcript__content" ref={contentRef}>
            {more
              ? <div className="control-transcript__edge">Loading earlier…</div>
              : loaded && <div className="control-transcript__edge">{entries.length ? 'The start of the conversation' : 'Nothing said to Control yet'}</div>}
            {shown.map((entry, i) => (
              <EntryRow
                key={entry.offset} entry={entry} previous={shown[i - 1]} parts={views.get(entry.offset)}
                unreadLine={entry.offset === firstWaiting} markable={markable.has(entry.offset)}
                played={speaking?.of === entry.offset ? speaking.parts : undefined}
                replaying={replaying?.of === entry.offset ? replaying.part : undefined}
              />
            ))}
            {unread > 0 && (
              <div className="control-transcript__read-all">
                <button className="control-transcript__button" onClick={() => window.api.receptionist.readAll()}>Mark all read</button>
              </div>
            )}
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
        <label
          className="control-transcript__reasoning"
          title="Show Control's reasoning: news as it arrives, what goes on and off its backlog, which agents it watches, and replies never spoken"
        >
          <input
            type="checkbox"
            checked={reasoning}
            onChange={(e) => useControlTranscriptStore.getState().setReasoning(e.target.checked)}
          />
          <span>Reasoning</span>
        </label>
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
      <ControlFooter extra={controlsExtra} />
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

/**
 * Where Control speaks, and the buttons that move it: the foot of the
 * transcript, under the box to type in. Two independent controls (`receptionist.hold`) — holding
 * Control here or not, and muting it here or not — so the user can mute
 * first and take Control after, and it arrives muted. And a catch-up while
 * replies wait unread.
 */
function ControlFooter({ extra }: { extra?: ReactNode }) {
  const holder = useReceptionistStore((s) => s.holder)
  const mutedHere = useReceptionistStore((s) => s.mutedHere)
  const unread = useReceptionistStore((s) => s.unread.count)
  const here = holder?.mine === true
  const where = here ? (mutedHere ? 'Control writes here, muted' : 'Control speaks here')
    : `${holder ? `Control is on your ${holder.label}` : 'Control is with nobody, and works silently'}${mutedHere ? ' · muted here' : ''}`
  const hold = window.api.receptionist.hold
  return (
    <div className="control-transcript__controls">
      <span className="control-transcript__where">{where}</span>
      <div className="control-transcript__controls-buttons">
        {unread > 0 && (
          <button className="control-transcript__button" onClick={() => window.api.receptionist.catchUp()}>
            Catch me up · {unread}
          </button>
        )}
        <button className="control-transcript__button" aria-pressed={mutedHere} onClick={() => hold(mutedHere ? 'unmute' : 'mute')}>
          {mutedHere ? 'Unmute' : 'Mute'}
        </button>
        <button className="control-transcript__button" aria-pressed={here} onClick={() => hold(here ? 'release' : 'take')}>
          {here ? 'Release' : 'Take Control'}
        </button>
        {extra}
      </div>
    </div>
  )
}

/**
 * `parts`: what of each part of this reply the user did not take in, if anything.
 * `unreadLine`: the first entry with words waiting for the user, under the Unread line.
 * `markable`: said since the user's last message, so a click on a word marks where they stopped.
 * `played`: how far the voice has got into each part, while it says this reply.
 * `replaying`: the part of it this device is playing again.
 */
function EntryRow({ entry, previous, parts, unreadLine, markable, played, replaying }: {
  entry: ControlTranscriptEntry; previous?: ControlTranscriptEntry; parts?: PartView[]
  unreadLine?: boolean; markable?: boolean; played?: number[]; replaying?: number
}) {
  if (entry.kind === 'heard' || entry.kind === 'consumed') return null
  const today = day(entry.timestamp)
  const divider = <>
    {today && today !== (previous ? day(previous.timestamp) : '') && <div className="control-transcript__day">{today}</div>}
    {unreadLine && <div className="control-transcript__unread-line">Unread</div>}
  </>
  const at = time(entry.timestamp)
  if (entry.kind === 'trace') {
    // Why Control did or did not speak: quieter than what it said and did, its detail one tap away.
    const className = 'control-transcript__entry control-transcript__entry--trace'
    return (
      <>
        {divider}
        {entry.detail
          ? (
            <details className={className} data-what={entry.what} title={at}>
              <summary>{entry.text}</summary>
              <div className="control-transcript__log-body">{entry.detail}</div>
            </details>
          )
          : <div className={className} data-what={entry.what} title={at}>{entry.text}</div>}
      </>
    )
  }
  if (entry.kind === 'log') {
    // What Control did, in full, is detail: one line until opened.
    const colon = entry.text.indexOf(': ')
    const head = colon < 0 ? entry.text : entry.text.slice(0, colon)
    // Never ran: the user spoke before Control's reply was said. Struck out:
    // it did not happen, unlike unheard words, which stand. A press asks
    // Control to do it after all.
    const notDone = entry.notDone === true
    const doItNow = () => {
      const text = `Please do this after all: ${entry.text}`
      window.api.receptionist.say(text)
      useControlTranscriptStore.getState().addPending(text)
    }
    return (
      <>
        {divider}
        <details
          className={`control-transcript__entry control-transcript__entry--log${notDone ? ' control-transcript__entry--not-done' : ''}`}
          data-entry-offset={entry.offset}
          // The verb picks the pill's colour: SENT, STARTED, ARCHIVED, …
          data-action={entry.text.split(' ')[0].toLowerCase()}
          title={notDone ? `Not done: you spoke before Control replied · ${at}` : at}
        >
          <summary>{notDone ? <><s>{head}</s> · not done, cut off</> : head}</summary>
          {colon >= 0 && <div className="control-transcript__log-body">{entry.text.slice(colon + 2)}</div>}
          {notDone && <button className="control-transcript__do-it" onClick={doItNow}>Do it now</button>}
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
      <div className="control-transcript__entry control-transcript__entry--reply" data-entry-offset={entry.offset}>
        {entry.parts.length === 0 && <div className="control-transcript__silent">Control said nothing</div>}
        {entry.parts.map((part, i) => {
          const view = parts?.[i]
          const waiting = view?.why === 'waiting' && view.missing.length > 0
          const playing = replaying === i
          const mark = (char: number) => window.api.receptionist.mark(entry.offset, i, char)
          return (
            <div key={i} className="control-transcript__part">
              {/* Every change of voice is headed, so each block says who spoke it. */}
              {(i === 0 || part.from !== entry.parts[i - 1].from) && (
                markable
                  ? (
                    <button className="control-transcript__meta control-transcript__meta--markable" title="Took in none of it from here" onClick={() => mark(0)}>
                      {part.from}{i === 0 ? ` · ${at}` : ''}
                    </button>
                  )
                  : <div className="control-transcript__meta">{part.from}{i === 0 ? ` · ${at}` : ''}</div>
              )}
              <div className="control-transcript__bubble-row">
                <div
                  className={`control-transcript__bubble${waiting ? ' control-transcript__bubble--waiting' : ''}${markable ? ' control-transcript__bubble--markable' : ''}`}
                  onClick={markable ? (e) => {
                    // Selecting words to copy them is not marking them.
                    if (!window.getSelection()?.isCollapsed) return
                    const word = (e.target as Element).closest<HTMLElement>('[data-end]')
                    if (word) mark(Number(word.dataset.end))
                  } : undefined}
                >
                  <PartText text={part.text} view={view} played={played?.[i]} markable={markable} />
                </div>
                <button
                  className={`control-transcript__replay${playing ? ' control-transcript__replay--playing' : ''}`}
                  aria-label={playing ? 'Stop playing this' : `Play this again, in ${part.from}'s voice`}
                  onClick={() => playing ? window.api.receptionist.stopReplay() : window.api.receptionist.replay(entry.offset, i)}
                >
                  {playing
                    ? <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="2" width="8" height="8" rx="1" fill="currentColor" /></svg>
                    : <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.5v9l7.5-4.5z" fill="currentColor" /></svg>}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}

/**
 * A part of a reply: what the user missed of it struck out, what waits for
 * them shown so, and while the voice says it, what it has yet to say dim.
 * `markable`: each word is drawn on its own, so
 * a click says which.
 */
function PartText({ text, view, played, markable }: { text: string; view?: PartView; played?: number; markable?: boolean }) {
  return (
    <>
      {segments(text, view, played).map((segment) => {
        const content = markable
          ? words(segment).map((word, j) => word.end === undefined ? word.text : <span key={j} className="control-transcript__word" data-end={word.end}>{word.text}</span>)
          : segment.text
        if (segment.kind === 'missed') return <s key={segment.from} className="control-transcript__missed" title="Not taken in">{content}</s>
        if (segment.kind === 'taken') return <span key={segment.from}>{content}</span>
        return <span key={segment.from} className={`control-transcript__${segment.kind}`}>{content}</span>
      })}
    </>
  )
}
