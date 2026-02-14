import type { TerminalInfo } from '../hooks/useTerminalManager'
import { terminalPixelSize } from '../lib/constants'
import { nodeCenter } from '../lib/tree-placement'

interface TreeLinesProps {
  terminals: TerminalInfo[]
}

export function TreeLines({ terminals }: TreeLinesProps) {
  return (
    <svg
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        overflow: 'visible',
        pointerEvents: 'none',
        zIndex: 0,
      }}
    >
      {terminals.map((t) => {
        const { width, height } = terminalPixelSize(t.cols, t.rows)
        const child = nodeCenter(t.x, t.y, width, height)

        let parent: { x: number; y: number }
        if (t.parentId === 'root') {
          parent = { x: 0, y: 0 }
        } else {
          const parentTerm = terminals.find((p) => p.sessionId === t.parentId)
          if (!parentTerm) {
            parent = { x: 0, y: 0 }
          } else {
            const ps = terminalPixelSize(parentTerm.cols, parentTerm.rows)
            parent = nodeCenter(parentTerm.x, parentTerm.y, ps.width, ps.height)
          }
        }

        return (
          <line
            key={t.sessionId}
            x1={parent.x}
            y1={parent.y}
            x2={child.x}
            y2={child.y}
            className="tree-line"
          />
        )
      })}
    </svg>
  )
}
