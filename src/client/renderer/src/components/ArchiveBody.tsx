import { nodeDisplayTitle } from '../lib/node-title'
import { relativeTime, typeLabel } from '../lib/search'
import type { ArchivedNode } from '../../../../shared/state'
import type { NodeData } from '../../../../shared/state'

interface ArchiveBodyProps {
  parentId: string
  archives: ArchivedNode[]
  onUnarchive: (parentNodeId: string, archivedNodeId: string) => void
  onArchiveDelete: (parentNodeId: string, archivedNodeId: string) => void
}

function countNestedArchives(data: NodeData): { direct: number; total: number } {
  const direct = data.archivedChildren.length
  let total = direct
  for (const child of data.archivedChildren) {
    total += countNestedArchives(child.data).total
  }
  return { direct, total }
}

function tooltipJson(data: NodeData): string {
  const { archivedChildren: _, ...rest } = data
  return JSON.stringify(rest, null, 2)
}

export function ArchiveBody({ parentId, archives, onUnarchive, onArchiveDelete }: ArchiveBodyProps) {
  return (
    <div className="archive-body" onMouseDown={(e) => e.stopPropagation()}>
      <div className="archive-body__list">
        {[...archives].reverse().map((entry) => {
          const { direct, total } = countNestedArchives(entry.data)
          return (
            <div
              key={entry.data.id}
              className="archive-body__card"
              title={tooltipJson(entry.data)}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest('.archive-body__action--delete')) return
                e.stopPropagation()
                onUnarchive(parentId, entry.data.id)
              }}
            >
              <div className="archive-body__card-header">
                <span className="archive-body__type">{typeLabel(entry.data)}</span>
                <span className="archive-body__time">{relativeTime(entry.archivedAt)}</span>
                <button
                  className="archive-body__action archive-body__action--delete"
                  title="Delete permanently"
                  onClick={(e) => { e.stopPropagation(); onArchiveDelete(parentId, entry.data.id) }}
                >
                  &times;
                </button>
              </div>
              <div className="archive-body__card-title">{nodeDisplayTitle(entry.data)}</div>
              {direct > 0 && (
                <div className="archive-body__card-meta">
                  {direct} archived{total > direct ? ` \u00B7 ${total} total` : ''}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
