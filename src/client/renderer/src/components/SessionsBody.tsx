import { relativeTime } from '../lib/search'
import type { TerminalSessionEntry } from '../../../../shared/state'

interface SessionsBodyProps {
  sessions: TerminalSessionEntry[]
  onRevive: (session: TerminalSessionEntry) => void
}

function triggerLabel(trigger: TerminalSessionEntry['trigger']): string {
  switch (trigger) {
    case 'initial': return 'Initial'
    case 'claude-session-change': return 'Session change'
    case 'claude-exit': return 'Claude exit'
    case 'reincarnation': return 'Reincarnation'
    default: return trigger
  }
}

function sessionTitle(session: TerminalSessionEntry): string {
  if (session.shellTitleHistory.length > 0) {
    return session.shellTitleHistory[session.shellTitleHistory.length - 1]
  }
  if (session.claudeSessionId) {
    return session.claudeSessionId.slice(0, 8)
  }
  return `Session ${session.sessionIndex + 1}`
}

function sessionDuration(session: TerminalSessionEntry): string | null {
  if (!session.endedAt) return null
  const start = new Date(session.startedAt).getTime()
  const end = new Date(session.endedAt).getTime()
  const diff = end - start
  if (diff < 0) return null
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export function SessionsBody({ sessions, onRevive }: SessionsBodyProps) {
  return (
    <div className="archive-body" onMouseDown={(e) => e.stopPropagation()}>
      <div className="archive-body__list">
        {[...sessions].reverse().map((session) => {
          const duration = sessionDuration(session)
          return (
            <div
              key={session.sessionIndex}
              className="archive-body__card"
              onClick={(e) => {
                e.stopPropagation()
                onRevive(session)
              }}
            >
              <div className="archive-body__card-header">
                <span className="archive-body__type">{triggerLabel(session.trigger)}</span>
                <span className="archive-body__time">{relativeTime(session.startedAt)}</span>
              </div>
              <div className="archive-body__card-title">{sessionTitle(session)}</div>
              {duration && (
                <div className="archive-body__card-meta">
                  Duration: {duration}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
