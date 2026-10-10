import { useEffect, useState } from 'react'
import { approvalKey, parseApprovalDocument, type ApprovalItem } from '../shared/approvals'
import { toneOf, useApprovalsStore } from './approvals-store'
import { ApprovalPairing, usePhoneIdentity } from './ApprovalPairing'
import { useUpdateNotices } from './update-notices'
import { lostStatuses, statusNoticeKey, type LostStatus } from './provider-status'

/** Ticks while mounted, for countdowns. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

/** "1:05", or null with no deadline yet. */
export function timeLeft(expiresAt: number | null, now: number): string | null {
  if (expiresAt === null) return null
  const s = Math.max(0, Math.ceil((expiresAt - now) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function Row({ item, now }: { item: ApprovalItem; now: number }) {
  const doc = parseApprovalDocument(item.document)
  const left = timeLeft(item.expiresAt, now)
  return (
    <button
      className={`m-notices__row m-notices__row--${toneOf(doc?.tone)}`}
      onClick={() => useApprovalsStore.getState().openItem(approvalKey(item))}
    >
      <span className="m-notices__text">
        <span className="m-notices__title">{doc?.title ?? 'A request this phone cannot show'}</span>
        {doc?.subtitle && <span className="m-notices__subtitle">{doc.subtitle}</span>}
      </span>
      <span className="m-notices__meta">{left ?? 'queued'}</span>
    </button>
  )
}

/** A source's status gone bad: opProxy's 1Password authorization lost. Nothing to tap; the Mac asks. */
function StatusRow({ lost }: { lost: LostStatus }) {
  const since = new Date(lost.status.since).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return (
    <div className="m-notices__row m-notices__row--caution">
      <span className="m-notices__text">
        <span className="m-notices__title">{lost.status.title ?? `${lost.status.label} lost`}</span>
        {lost.status.detail && <span className="m-notices__subtitle">{lost.status.detail}</span>}
      </span>
      <span className="m-notices__meta">{since}</span>
    </div>
  )
}

/**
 * Notifications, at the top of the toolbar sheet: lost statuses, then
 * requests, newest first; a tap opens one. Below them, each source's state —
 * not running, or whether this phone is paired with it, with the button to
 * pair it. Nothing at all with nothing to show.
 *
 * Updates waiting are not rows here: the strip's own buttons below march
 * their ants for them. They still count toward the rocket, and the sheet
 * showing them is what reads them.
 */
export function NotificationsSection() {
  const snapshot = useApprovalsStore((s) => s.snapshot)
  const identity = usePhoneIdentity()
  const now = useNow()
  const updates = useUpdateNotices()
  const lost = lostStatuses(snapshot)
  const items = [...snapshot.items].sort((a, b) => b.createdAt - a.createdAt)
  // Mounted with the sheet: whatever is waiting has been seen, and so has an update raised while it is up.
  const updateKinds = updates.map((u) => u.kind).join()
  useEffect(() => { useApprovalsStore.getState().markAllRead() }, [updateKinds])
  if (!items.length && !lost.length && !snapshot.sources.length) return null
  return (
    <section className="m-notices" aria-label="Notifications">
      <div className="m-notices__header">Notifications</div>
      <div className="m-notices__list">
        {lost.map((l) => <StatusRow key={statusNoticeKey(l)} lost={l} />)}
        {items.map((item) => <Row key={approvalKey(item)} item={item} now={now} />)}
        {snapshot.sources.map((source) => (
          <div key={source.name} className="m-notices__source">
            <ApprovalPairing source={source} identity={identity} />
          </div>
        ))}
      </div>
    </section>
  )
}
