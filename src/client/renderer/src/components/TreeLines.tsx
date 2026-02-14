import { nodeCenter } from '../lib/tree-placement'

export interface TreeLineNode {
  id: string
  parentId: string
  x: number
  y: number
  width: number
  height: number
}

interface TreeLinesProps {
  nodes: TreeLineNode[]
}

export function TreeLines({ nodes }: TreeLinesProps) {
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
      {nodes.map((n) => {
        const child = nodeCenter(n.x, n.y, n.width, n.height)

        let parent: { x: number; y: number }
        if (n.parentId === 'root') {
          parent = { x: 0, y: 0 }
        } else {
          const parentNode = nodes.find((p) => p.id === n.parentId)
          if (!parentNode) {
            parent = { x: 0, y: 0 }
          } else {
            parent = nodeCenter(parentNode.x, parentNode.y, parentNode.width, parentNode.height)
          }
        }

        return (
          <line
            key={n.id}
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
