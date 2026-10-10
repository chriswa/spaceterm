import { useSurfacePresenterStore } from '@/stores/surfacePresenterStore'
import { loudestTone, pendingKeys, unreadCount, useApprovalsStore } from './approvals-store'
import { updateNoticeKey, useUpdateNotices } from './update-notices'
import { lostStatuses } from './provider-status'

/**
 * The bottom bar's rocket: opens the toolbar, which on the phone is a sheet
 * with the phone's notifications at its top (NotificationsSection.tsx) and the
 * surfaces in it, and closes it again — the bar stays over it.
 *
 * It is also where notifications show: a count of what is waiting — approval
 * requests waiting on the Mac, opProxy's 1Password authorization lost, updates
 * waiting to be done (whose buttons march in the sheet's strip) — in the
 * loudest one's tone, and a ring pulsing out while any of it is unread, until
 * the sheet has shown it.
 */
export function RocketButton() {
  const open = useSurfacePresenterStore((s) => s.toolbarSheetOpen)
  const snapshot = useApprovalsStore((s) => s.snapshot)
  const seen = useApprovalsStore((s) => s.seen)
  const updates = useUpdateNotices()
  const updateKeys = updates.map((u) => updateNoticeKey(u.kind))
  const pending = pendingKeys(snapshot, updateKeys).length
  const unread = unreadCount(snapshot, updateKeys, seen)
  const tone = loudestTone(snapshot.items) ?? (lostStatuses(snapshot).length ? 'caution' : updates.length ? 'info' : null)
  const waiting = pending ? ` — ${pending} waiting${unread ? `, ${unread} new` : ''}` : ''
  return (
    <button
      className={`m-bar__button m-rocket${open ? ' m-bar__button--on' : ''}${tone ? ` m-rocket--${tone}` : ''}${unread ? ' m-rocket--unread' : ''}`}
      onClick={() => useSurfacePresenterStore.getState().setToolbarSheetOpen(!open)}
      aria-label={open ? 'Back to the canvas' : `Toolbar and surfaces${waiting}`}
      aria-expanded={open}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        {/* A rocket climbing to the upper right. */}
        <path d="M20.6 3.4c-3.9-.3-7.6 1.3-10.2 4.3L8.9 9.4l-3.6.4L3 12.1l3.7 1.2 4 4 1.2 3.7 2.3-2.3.4-3.6 1.7-1.5c3-2.6 4.6-6.3 4.3-10.2zM15.5 10.4a1.9 1.9 0 1 1 0-3.8 1.9 1.9 0 0 1 0 3.8z" />
        <path d="M6.2 15.9c-1.3.4-2.2 1.9-2.6 4.5 2.6-.4 4.1-1.3 4.5-2.6z" opacity="0.7" />
      </svg>
      {pending > 0 && <span className="m-rocket__count">{pending}</span>}
    </button>
  )
}
