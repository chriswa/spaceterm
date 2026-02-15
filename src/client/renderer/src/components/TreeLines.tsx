export interface TreeLineNode {
  id: string
  parentId: string
  x: number
  y: number
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
        let parent: { x: number; y: number }
        if (n.parentId === 'root') {
          parent = { x: 0, y: 0 }
        } else {
          const parentNode = nodes.find((p) => p.id === n.parentId)
          if (!parentNode) {
            parent = { x: 0, y: 0 }
          } else {
            parent = { x: parentNode.x, y: parentNode.y }
          }
        }

        return (
          <line
            key={n.id}
            x1={parent.x}
            y1={parent.y}
            x2={n.x}
            y2={n.y}
            className="tree-line"
          />
        )
      })}
    </svg>
  )
}
