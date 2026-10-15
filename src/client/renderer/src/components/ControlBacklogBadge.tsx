import { useReceptionistStore } from '../stores/receptionistStore'

/** How many things Control has set aside to bring up later, in words, or null when nothing is. */
export function backlogBadgeText(count: number): string | null {
  if (count <= 0) return null
  return `${count} backlog ${count === 1 ? 'item' : 'items'}`
}

/** The badge over the holder badge, in the transcript's foot: see `backlogBadgeText`. */
export function ControlBacklogBadge() {
  const text = useReceptionistStore((s) => backlogBadgeText(s.backlog))
  if (!text) return null
  return <div className="control-transcript__holder-badge control-transcript__holder-badge--backlog" role="status">{text}</div>
}
