import { useId, useState } from 'react'
import { useReceptionistStore } from '../stores/receptionistStore'
import type { ReceptionistBacklogEntry } from '../../../../shared/protocol'

/** How many things Control has set aside to bring up later, in words, or null when nothing is. */
export function backlogBadgeText(count: number): string | null {
  if (count <= 0) return null
  return `${count} backlog ${count === 1 ? 'item' : 'items'}`
}

/** How long an item has waited, as the list beside it says. */
export function backlogItemAge(addedAt: number, now: number): string {
  const minutes = Math.floor((now - addedAt) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/**
 * The badge over the holder badge, in the transcript's foot: see
 * `backlogBadgeText`. Pressed, it lists the items above itself.
 *
 * Whether the list is open is state of `OpenableBacklogBadge`, which exists
 * only while there are items to list: the backlog emptying unmounts it, so
 * the list closes with the badge and the next item finds it closed.
 */
export function ControlBacklogBadge() {
  const text = useReceptionistStore((s) => backlogBadgeText(s.backlog))
  const items = useReceptionistStore((s) => s.backlogItems)
  if (!text) return null
  // A server too old to list its backlog sends only the count.
  if (!items.length) return <div className="control-transcript__holder-badge control-transcript__holder-badge--backlog" role="status">{text}</div>
  return <OpenableBacklogBadge text={text} items={items} />
}

function OpenableBacklogBadge({ text, items }: { text: string; items: readonly ReceptionistBacklogEntry[] }) {
  const [open, setOpen] = useState(false)
  const listId = useId()
  const now = Date.now()
  return (
    <>
      {open && (
        <ol id={listId} className="control-transcript__backlog-list" aria-label="Backlog">
          {items.map((item) => (
            <li key={`${item.addedAt}:${item.text}`} className="control-transcript__backlog-item">
              {item.text}
              <span className="control-transcript__backlog-age"> · {backlogItemAge(item.addedAt, now)}</span>
            </li>
          ))}
        </ol>
      )}
      <button
        type="button"
        className="control-transcript__holder-badge control-transcript__holder-badge--backlog control-transcript__backlog-toggle"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-live="polite"
        onClick={() => setOpen((was) => !was)}
      >
        {text}
        <span aria-hidden="true">{open ? ' ▴' : ' ▾'}</span>
      </button>
    </>
  )
}
