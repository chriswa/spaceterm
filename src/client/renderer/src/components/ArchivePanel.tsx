import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { nodeDisplayTitle } from '../lib/node-title'
import type { ArchivedNode } from '../../../../shared/state'

interface ArchivePanelProps {
  parentId: string
  archives: ArchivedNode[]
  anchorRef: React.RefObject<HTMLButtonElement | null>
  onUnarchive: (parentNodeId: string, archivedNodeId: string) => void
  onArchiveDelete: (parentNodeId: string, archivedNodeId: string) => void
  onClose: () => void
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

export function ArchivePanel({ parentId, archives, anchorRef, onUnarchive, onArchiveDelete, onClose }: ArchivePanelProps) {
  const panelRef = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        anchorRef.current && !anchorRef.current.contains(e.target as Node)
      ) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [onClose, anchorRef])

  // Position the panel below the anchor button
  const anchor = anchorRef.current
  let top = 0
  let right = 0
  if (anchor) {
    const rect = anchor.getBoundingClientRect()
    top = rect.bottom + 4
    right = window.innerWidth - rect.right
  }

  return createPortal(
    <div
      className="archive-panel"
      ref={panelRef}
      style={{ position: 'fixed', top, right }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="archive-panel__header">Archived Children</div>
      <div className="archive-panel__list">
        {[...archives].reverse().map((entry) => (
          <div key={entry.data.id} className="archive-panel__row">
            <span className="archive-panel__name">{nodeDisplayTitle(entry.data)}</span>
            <span className="archive-panel__time">{relativeTime(entry.archivedAt)}</span>
            <button
              className="archive-panel__action archive-panel__action--restore"
              title="Unarchive"
              onClick={(e) => { e.stopPropagation(); onUnarchive(parentId, entry.data.id) }}
            >
              &#x21A9;
            </button>
            <button
              className="archive-panel__action archive-panel__action--delete"
              title="Delete permanently"
              onClick={(e) => { e.stopPropagation(); onArchiveDelete(parentId, entry.data.id) }}
            >
              &times;
            </button>
          </div>
        ))}
      </div>
    </div>,
    document.body
  )
}
