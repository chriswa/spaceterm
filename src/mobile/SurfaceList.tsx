import { useMemo } from 'react'
import { useNodeStore } from '@/stores/nodeStore'
import { deriveCrabs } from '@/lib/crab-entries'
import { CRAB_COLORS } from '@/lib/crab-nav'
import type { NodeId } from '../shared/ids'

/**
 * The toolbar's crab row as a list a thumb can hit: every surface in the
 * operator's order, coloured by state exactly as on the desktop.
 */
export function SurfaceList({ onPick, onClose }: { onPick: (nodeId: NodeId) => void; onClose: () => void }) {
  const nodes = useNodeStore((s) => s.nodes)
  const crabs = useMemo(() => deriveCrabs(nodes), [nodes])

  return (
    <div className="mobile-sheet" role="dialog" aria-label="Surfaces" onClick={onClose}>
      <div className="mobile-sheet__panel" onClick={(e) => e.stopPropagation()}>
        <header className="mobile-term__bar">
          <span className="mobile-term__title">Surfaces</span>
          <button className="mobile-btn" onClick={onClose}>Done</button>
        </header>
        <ul className="mobile-list">
          {crabs.map((crab) => (
            <li key={crab.nodeId}>
              <button className="mobile-list__item" onClick={() => onPick(crab.nodeId)}>
                <span
                  className={`mobile-list__dot${crab.unviewed ? ' mobile-list__dot--unviewed' : ''}`}
                  style={{ background: CRAB_COLORS[crab.color] }}
                />
                <span className="mobile-list__title">{crab.title}</span>
                <span className="mobile-list__kind">{crab.kind}</span>
              </button>
            </li>
          ))}
          {crabs.length === 0 && <li className="mobile-list__empty">No surfaces yet.</li>}
        </ul>
      </div>
    </div>
  )
}
