import { useCallback } from 'react'
import { ROOT_NODE_RADIUS } from '../lib/constants'

interface RootNodeProps {
  focused: boolean
  onClick: () => void
}

export function RootNode({ focused, onClick }: RootNodeProps) {
  const size = ROOT_NODE_RADIUS * 2

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    onClick()
  }, [onClick])

  return (
    <div
      className={`root-node${focused ? ' root-node--focused' : ''}`}
      style={{
        position: 'absolute',
        left: -ROOT_NODE_RADIUS,
        top: -ROOT_NODE_RADIUS,
        width: size,
        height: size,
      }}
      onMouseDown={handleMouseDown}
    />
  )
}
