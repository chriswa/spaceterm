import type { ArchivedNode } from '../../../../shared/state'

const MAX_VISIBLE = 10

interface ArchiveStripProps {
  archives: ArchivedNode[]
}

export function ArchiveStrip({ archives }: ArchiveStripProps) {
  if (archives.length === 0) return null

  const visible = archives.length > MAX_VISIBLE ? archives.slice(-MAX_VISIBLE) : archives

  return (
    <div className="archive-strip">
      {visible.map((entry, i) => (
        <div key={`${entry.data.id}-${i}`} className="archive-strip__line">
          {JSON.stringify(entry)}
        </div>
      ))}
    </div>
  )
}
