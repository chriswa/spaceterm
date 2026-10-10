import { useEffect } from 'react'
import { useSurfacePresenterStore } from '@/stores/surfacePresenterStore'
import { updateNoticeKey, useNoticesRead, useUpdateNotices } from './update-notices'

/**
 * The bottom bar's rocket: opens the toolbar, which on the phone is a sheet
 * with the surfaces in it, and closes it again — the bar stays over it.
 *
 * It is also where notifications show (update-notices.ts): a count of the
 * updates waiting to be done, whose buttons march in the sheet's strip, and a
 * ring pulsing out while any of them is unread, until the sheet has shown it.
 */
export function RocketButton() {
  const open = useSurfacePresenterStore((s) => s.toolbarSheetOpen)
  const seen = useNoticesRead((s) => s.seen)
  const updates = useUpdateNotices()
  const updateKeys = updates.map((u) => updateNoticeKey(u.kind))
  const pending = updateKeys.length
  const unread = updateKeys.filter((key) => !seen.has(key)).length
  // The sheet up: whatever is waiting has been seen, and so has an update raised while it is up.
  const updateKinds = updateKeys.join()
  useEffect(() => {
    if (open) useNoticesRead.getState().markAllRead()
  }, [open, updateKinds])
  const waiting = pending ? ` — ${pending} waiting${unread ? `, ${unread} new` : ''}` : ''
  return (
    <button
      className={`m-bar__button m-rocket${open ? ' m-bar__button--on' : ''}${pending ? ' m-rocket--info' : ''}${unread ? ' m-rocket--unread' : ''}`}
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
