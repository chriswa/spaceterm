import type { NodeAlert } from '../../../../shared/state'

interface AlertsBodyProps {
  alerts: NodeAlert[]
  alertsReadTimestamp?: number
}

export function AlertsBody({ alerts, alertsReadTimestamp }: AlertsBodyProps) {
  return (
    <div className="archive-body" onMouseDown={(e) => e.stopPropagation()}>
      {alerts.map((alert, i) => {
        const isUnread = alert.timestamp > (alertsReadTimestamp ?? 0)
        return (
          <div key={`${alert.type}-${i}`} className={`alerts-body__item${isUnread ? ' alerts-body__item--unread' : ''}`}>
            <svg className="alerts-body__icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 1.5 L14.5 13 L1.5 13 Z" />
              <line x1="8" y1="6" x2="8" y2="9.5" />
              <circle cx="8" cy="11.5" r="0.5" fill="currentColor" stroke="none" />
            </svg>
            <span className="alerts-body__message">{alert.message}</span>
          </div>
        )
      })}
    </div>
  )
}
