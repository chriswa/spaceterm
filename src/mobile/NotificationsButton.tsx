import { loudestTone, unreadCount, useApprovalsStore } from './approvals-store'
import { updateNoticeKey, useUpdateNotices } from './update-notices'

/**
 * The bottom bar's bell, left of the rocket: the phone's notifications —
 * approval requests waiting on the Mac (opProxy's), and updates waiting to be
 * done (a flagged server restart, a newer app, a newer page).
 *
 * Dim with nothing pending — still a button, since the list it opens is also
 * where this phone is paired. Lit in the most urgent request's tone while
 * anything is pending, and pulsing while any of it is unread. Updates alone
 * light it in the info tone.
 */
export function NotificationsButton() {
  const snapshot = useApprovalsStore((s) => s.snapshot)
  const seen = useApprovalsStore((s) => s.seen)
  const open = useApprovalsStore((s) => s.listOpen)
  const updates = useUpdateNotices()
  const pending = snapshot.items.length + updates.length
  const unread = unreadCount(snapshot, updates.map((u) => updateNoticeKey(u.kind)), seen)
  const tone = loudestTone(snapshot.items) ?? (updates.length ? 'info' : null)
  const state = tone ? ` m-bell--${tone}` : ' m-bell--idle'
  return (
    <button
      className={`m-bar__button m-bell${state}${unread ? ' m-bell--unread' : ''}${open ? ' m-bell--open' : ''}`}
      onClick={() => useApprovalsStore.getState().setListOpen(!open)}
      aria-label={pending ? `Notifications — ${pending} waiting${unread ? `, ${unread} new` : ''}` : 'Notifications — nothing waiting'}
      aria-expanded={open}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 2.5a1.5 1.5 0 0 0-1.5 1.5v.6A6.5 6.5 0 0 0 5.5 11v4.2L3.8 17.4a1 1 0 0 0 .8 1.6h14.8a1 1 0 0 0 .8-1.6l-1.7-2.2V11a6.5 6.5 0 0 0-5-6.4V4A1.5 1.5 0 0 0 12 2.5z" />
        <path d="M9.5 20.2a2.5 2.5 0 0 0 5 0z" />
      </svg>
      {pending > 0 && <span className="m-bell__count">{pending}</span>}
    </button>
  )
}
