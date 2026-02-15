import { nodeDisplayTitle } from '../lib/node-title'
import type { ArchivedNode } from '../../../../shared/state'

interface ArchiveBodyProps {
  parentId: string
  archives: ArchivedNode[]
  onUnarchive: (parentNodeId: string, archivedNodeId: string) => void
  onArchiveDelete: (parentNodeId: string, archivedNodeId: string) => void
}

function relativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function ArchiveBody({ parentId, archives, onUnarchive, onArchiveDelete }: ArchiveBodyProps) {
  return (
    <div className="archive-body" onMouseDown={(e) => e.stopPropagation()}>
      <div className="archive-body__header">Archived Children</div>
      <div className="archive-body__list">
        {[...archives].reverse().map((entry) => (
          <div key={entry.data.id} className="archive-body__row">
            <span className="archive-body__name">{nodeDisplayTitle(entry.data)}</span>
            <span className="archive-body__time">{relativeTime(entry.archivedAt)}</span>
            <button
              className="archive-body__action archive-body__action--restore"
              title="Unarchive"
              onClick={(e) => { e.stopPropagation(); onUnarchive(parentId, entry.data.id) }}
            >
              &#x21A9;
            </button>
            <button
              className="archive-body__action archive-body__action--delete"
              title="Delete permanently"
              onClick={(e) => { e.stopPropagation(); onArchiveDelete(parentId, entry.data.id) }}
            >
              &times;
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
