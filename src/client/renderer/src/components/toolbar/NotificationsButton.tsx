import { useEffect, useState } from 'react'
import type { NotificationKind, NotificationRecord } from '../../../../../shared/notifications'
import { showAgent } from '../ControlTranscript'
import { useToolbarMenu } from './useToolbarMenu'
import { NotificationLogIcon } from './icons'

/**
 * The notifications sent towards the phone, newest first: when, why, and which
 * surface. A row goes to that surface. Like the automation event log, the
 * panel is what subscribes, so a closed one costs nothing.
 */
export function NotificationsButton() {
  const menu = useToolbarMenu()
  return (
    <div className="toolbar__menu-group" ref={menu.ref}>
      <button
        className={'toolbar__btn' + (menu.open ? ' toolbar__btn--active' : '')}
        onClick={menu.toggle}
        aria-label="Notifications"
        data-tooltip="Notifications — what was sent to your phone"
        data-tooltip-no-flip
      >
        <NotificationLogIcon />
      </button>
      {menu.open && <NotificationPanel onGo={menu.close} />}
    </div>
  )
}

export const KIND_LABELS: Record<NotificationKind, string> = {
  permission: 'Permission',
  question: 'Question',
  plan: 'Plan',
  manual: 'Manual',
}

/** Newest first, each once: one can arrive both live and in the list. */
function merged(current: NotificationRecord[], incoming: NotificationRecord[]): NotificationRecord[] {
  const bySeq = new Map(current.map((n) => [n.seq, n]))
  for (const n of incoming) bySeq.set(n.seq, n)
  return [...bySeq.values()].sort((a, b) => b.seq - a.seq)
}

function NotificationPanel({ onGo }: { onGo: () => void }) {
  const [notifications, setNotifications] = useState<NotificationRecord[]>([])

  useEffect(() => {
    let cancelled = false
    // Subscribed before asking, so one sent in between is not missed.
    const unsubscribe = window.api.node.onNotificationSent((n) => setNotifications((cur) => merged(cur, [n])))
    void window.api.node.notifications().then((list) => {
      if (!cancelled) setNotifications((cur) => merged(cur, list))
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return (
    <div className="toolbar__menu toolbar__menu--events toolbar__menu--notifications">
      <div className="toolbar__menu-heading">Notifications</div>
      {notifications.length === 0 && <div className="event-log__empty">None sent yet.</div>}
      {notifications.map((n) => {
        const go = () => showAgent(n.nodeId, onGo)
        return (
          <div
            key={n.seq}
            className="event-log__row"
            role="button"
            tabIndex={0}
            title={n.body}
            onClick={go}
            onKeyDown={(e) => { if (e.key === 'Enter') go() }}
          >
            <div className="event-log__head">
              <span className="event-log__time">{formatTime(n.at)}</span>
              <span className={`notification-log__kind notification-log__kind--${n.kind}`}>{KIND_LABELS[n.kind]}</span>
              <span className="notification-log__title">{n.title}</span>
              {!n.reached && <span className="notification-log__unreached">not delivered</span>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** Time alone for today, with the date for anything older. */
function formatTime(at: number): string {
  const when = new Date(at)
  const time = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (when.toDateString() === new Date().toDateString()) return time
  return `${when.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}
