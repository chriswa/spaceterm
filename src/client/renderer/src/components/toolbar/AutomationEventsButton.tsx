import { useEffect, useState } from 'react'
import type { AutomationEventOutcome, AutomationEventRecord } from '../../../../../shared/automation'
import { useToolbarMenu } from './useToolbarMenu'
import { EventLogIcon } from './icons'

/**
 * The automation event log: every event scripts have sent, newest first, and
 * whether anything heard it.
 *
 * The panel is what subscribes, so a closed log costs a client nothing, and
 * opening it always shows the server's current list.
 */
export function AutomationEventsButton() {
  const menu = useToolbarMenu()
  return (
    <div className="toolbar__menu-group" ref={menu.ref}>
      <button
        className={'toolbar__btn' + (menu.open ? ' toolbar__btn--active' : '')}
        onClick={menu.toggle}
        aria-label="Automation events"
        data-tooltip="Automation events — what scripts have sent, heard or not"
        data-tooltip-no-flip
      >
        <EventLogIcon />
      </button>
      {menu.open && <AutomationEventPanel />}
    </div>
  )
}

/** Newest first, each once: an event can arrive both live and in the list. */
function merged(current: AutomationEventRecord[], incoming: AutomationEventRecord[]): AutomationEventRecord[] {
  const bySeq = new Map(current.map((e) => [e.seq, e]))
  for (const event of incoming) bySeq.set(event.seq, event)
  return [...bySeq.values()].sort((a, b) => b.seq - a.seq)
}

function AutomationEventPanel() {
  const [events, setEvents] = useState<AutomationEventRecord[]>([])
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())

  useEffect(() => {
    let cancelled = false
    // Subscribed before asking, so an event landing in between is not missed.
    const unsubscribe = window.api.node.onAutomationEvent((event) => setEvents((cur) => merged(cur, [event])))
    void window.api.node.automationEvents().then((list) => {
      if (!cancelled) setEvents((cur) => merged(cur, list))
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const toggle = (seq: number) => setExpanded((cur) => {
    const next = new Set(cur)
    if (!next.delete(seq)) next.add(seq)
    return next
  })

  return (
    <div className="toolbar__menu toolbar__menu--events">
      <div className="toolbar__menu-heading">Automation events</div>
      {events.length === 0 && (
        <div className="event-log__empty">
          None yet. A script sends one with <code>spaceterm-cli fire custom_name</code>.
        </div>
      )}
      {events.map((event) => (
        <EventRow key={event.seq} event={event} expanded={expanded.has(event.seq)} onToggle={() => toggle(event.seq)} />
      ))}
    </div>
  )
}

function EventRow({ event, expanded, onToggle }: { event: AutomationEventRecord; expanded: boolean; onToggle: () => void }) {
  const summary = payloadSummary(event)
  return (
    <div className="event-log__row" role="button" tabIndex={0} aria-expanded={expanded} onClick={onToggle} onKeyDown={(e) => { if (e.key === 'Enter') onToggle() }}>
      <div className="event-log__head">
        <span className="event-log__time">{formatEventTime(event.at)}</span>
        <span className="event-log__id">{event.eventId}</span>
        <span className={`event-log__outcome event-log__outcome--${event.outcome.kind}`}>{outcomeLabel(event.outcome)}</span>
      </div>
      {!expanded && summary && <div className="event-log__summary">{summary}</div>}
      {event.outcome.kind === 'rejected' && <div className="event-log__detail">{event.outcome.error}</div>}
      {expanded && event.source && <div className="event-log__source">from {event.source}</div>}
      {expanded && summary && (
        // Selecting text to copy must not collapse the row.
        <pre className="event-log__payload" onClick={(e) => e.stopPropagation()}>{payloadDetail(event)}</pre>
      )}
    </div>
  )
}

export function outcomeLabel(outcome: AutomationEventOutcome): string {
  switch (outcome.kind) {
    case 'fired':
      return outcome.matched === 1 ? '1 card' : `${outcome.matched} cards`
    case 'unheard':
      if (outcome.disabled === 0) return 'no card listening'
      return outcome.disabled === 1 ? '1 card, switched off' : `${outcome.disabled} cards, switched off`
    case 'rejected':
      return 'rejected'
  }
}

function payloadSummary(event: AutomationEventRecord): string | undefined {
  if (event.oversizedPayload) return `${event.oversizedPayload.preview.slice(0, 200)}…`
  return event.payload === undefined ? undefined : JSON.stringify(event.payload)
}

function payloadDetail(event: AutomationEventRecord): string {
  if (event.oversizedPayload) {
    return `${event.oversizedPayload.preview}…\n\n(only the start of ${event.oversizedPayload.bytes} bytes was kept)`
  }
  return JSON.stringify(event.payload, null, 2)
}

/** Time alone for today, with the date for anything older. */
function formatEventTime(at: number): string {
  const when = new Date(at)
  const time = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
  if (when.toDateString() === new Date().toDateString()) return time
  return `${when.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}
