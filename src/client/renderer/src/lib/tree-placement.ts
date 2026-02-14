import { CHILD_PLACEMENT_DISTANCE } from './constants'

export function nodeCenter(x: number, y: number, width: number, height: number): { x: number; y: number } {
  return { x: x + width / 2, y: y + height / 2 }
}

/**
 * Find the best angle to place a new child around a parent node.
 *
 * Avoids the direction toward the grandparent (weighted 3x) and existing siblings.
 * If parent is root (no grandparent), the avoid angle is PI/2 (downward),
 * so the first child is placed upward (opposite).
 */
export function computeChildPlacement(
  parentCenter: { x: number; y: number },
  grandparentCenter: { x: number; y: number } | null,
  siblingCenters: { x: number; y: number }[],
  distance: number = CHILD_PLACEMENT_DISTANCE
): { x: number; y: number } {
  const TWO_PI = Math.PI * 2

  // Avoid angle: direction from parent toward grandparent (or downward if root)
  const avoidAngle = grandparentCenter
    ? Math.atan2(grandparentCenter.y - parentCenter.y, grandparentCenter.x - parentCenter.x)
    : Math.PI / 2 // downward, so first child goes up (opposite = -PI/2)

  // Normalize angle to [0, 2PI)
  const normalize = (a: number) => ((a % TWO_PI) + TWO_PI) % TWO_PI

  // Sibling angles relative to parent
  const siblingAngles = siblingCenters.map((s) =>
    normalize(Math.atan2(s.y - parentCenter.y, s.x - parentCenter.x))
  )

  // If no siblings, place opposite the avoid angle
  if (siblingAngles.length === 0) {
    const angle = normalize(avoidAngle + Math.PI)
    return {
      x: parentCenter.x + Math.cos(angle) * distance,
      y: parentCenter.y + Math.sin(angle) * distance
    }
  }

  // Occupied angles = sibling angles + avoid angle repeated 3x (extra weight)
  const occupied = [
    ...siblingAngles,
    normalize(avoidAngle),
    normalize(avoidAngle + 0.01),
    normalize(avoidAngle - 0.01)
  ]

  occupied.sort((a, b) => a - b)

  // Find the largest angular gap
  let bestGap = 0
  let bestMidAngle = 0

  for (let i = 0; i < occupied.length; i++) {
    const next = i + 1 < occupied.length ? occupied[i + 1] : occupied[0] + TWO_PI
    const gap = next - occupied[i]
    if (gap > bestGap) {
      bestGap = gap
      bestMidAngle = occupied[i] + gap / 2
    }
  }

  const angle = normalize(bestMidAngle)
  return {
    x: parentCenter.x + Math.cos(angle) * distance,
    y: parentCenter.y + Math.sin(angle) * distance
  }
}
