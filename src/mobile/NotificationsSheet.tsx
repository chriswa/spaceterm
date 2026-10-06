import { useEffect, useState } from 'react'
import { approvalKey, parseApprovalDocument, type ApprovalItem } from '../shared/approvals'
import { toneOf, useApprovalsStore } from './approvals-store'
import { ApprovalPairing, usePhoneIdentity } from './ApprovalPairing'
import { useUpdateNotices, type UpdateNotice } from './update-notices'
import { useUpdateActionsStore } from '@/stores/updateActionsStore'

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

/** An update waiting to be done, with the button that does it. Not the whole row, so a stray tap restarts nothing. */
function UpdateRow({ notice }: { notice: UpdateNotice }) {
  const running = useUpdateActionsStore((s) => s.running[notice.kind])
  const act = () => {
    const actions = useUpdateActionsStore.getState()
    if (notice.kind === 'reload') actions.reload()
    else void actions[notice.kind]()
  }
  return (
    <div className="m-notices__row m-notices__row--info">
      <span className="m-notices__text">
        <span className="m-notices__title">{notice.title}</span>
        <span className="m-notices__subtitle">{notice.subtitle}</span>
      </span>
      <button className="m-notices__action" onClick={act} disabled={running}>
        {running ? notice.busy : notice.action}
      </button>
    </div>
  )
}

/**
 * The bell's list: the screen above the bottom bar. Updates waiting first,
 * then requests, newest first; a tap opens one. Below them, each source's
 * state — not running, or whether this phone is paired with it, with the
 * button to pair it.
 */
export function NotificationsSheet() {
  const snapshot = useApprovalsStore((s) => s.snapshot)
  const identity = usePhoneIdentity()
  const now = useNow()
  const updates = useUpdateNotices()
  const items = [...snapshot.items].sort((a, b) => b.createdAt - a.createdAt)
  // An update raised while the list is up has been seen.
  const updateKinds = updates.map((u) => u.kind).join()
  useEffect(() => { useApprovalsStore.getState().markAllRead() }, [updateKinds])
  return (
    <div className="m-notices" role="dialog" aria-label="Notifications">
      <div className="m-notices__header">
        <span>Notifications</span>
        <button className="m-notices__close" onClick={() => useApprovalsStore.getState().setListOpen(false)} aria-label="Close">✕</button>
      </div>
      <div className="m-notices__list">
        {items.length === 0 && updates.length === 0 && <p className="m-notices__empty">Nothing is waiting for you.</p>}
        {updates.map((notice) => <UpdateRow key={notice.kind} notice={notice} />)}
        {items.map((item) => <Row key={approvalKey(item)} item={item} now={now} />)}
        {snapshot.sources.map((source) => (
          <div key={source.name} className="m-notices__source">
            <ApprovalPairing source={source} identity={identity} />
          </div>
        ))}
      </div>
    </div>
  )
}
