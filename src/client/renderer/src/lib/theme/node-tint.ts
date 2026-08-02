import { angleBorderColor, angleColorPreset } from '../angle-color'
import { DEFAULT_PRESET, type ColorPreset } from '../color-presets'

/**
 * Implementations of the `nodeTint` facet: where a node's colour comes from
 * when the user has not chosen one.
 *
 * Two answers, and they are a real design disagreement rather than a setting.
 *
 * - **Angle** derives a hue from the node's bearing from the origin, matching
 *   the canvas background's radial hue ramp. Every node is coloured, colour is
 *   free, and it tells you roughly where on the canvas something lives.
 * - **Neutral** gives every node the same near-white preset and lets colour
 *   mean only what the user says it means. Nothing is coloured by accident, so
 *   a coloured subtree stands out — but position no longer reads as hue.
 *
 * A theme picks one. That is why this is a facet and not a checkbox: the
 * choice belongs with the background it has to sit against, and a rainbow
 * background under neutral nodes (or the reverse) looks like a mistake.
 */
export interface NodeTintFacet {
  readonly id: string
  readonly label: string
  /** The preset for a node with no explicit and no inherited colour. */
  presetFor(x: number, y: number): ColorPreset
  /**
   * The focus glow and selection border for a node at this position.
   * `boost` (>1) is used for terminal scroll mode, which wants a hotter ring.
   */
  borderColor(x: number, y: number, boost?: number): string
}

/** Off-white, and a plain white when boosted. Bright enough to read on any card. */
const NEUTRAL_BORDER = '#dfe6f2'
const NEUTRAL_BORDER_BOOSTED = '#ffffff'

export const NODE_TINTS = {
  angle: {
    id: 'angle',
    label: 'By angle',
    presetFor: angleColorPreset,
    borderColor: angleBorderColor,
  },
  neutral: {
    id: 'neutral',
    label: 'Neutral',
    presetFor: () => DEFAULT_PRESET,
    borderColor: (_x: number, _y: number, boost = 1) =>
      boost > 1 ? NEUTRAL_BORDER_BOOSTED : NEUTRAL_BORDER,
  },
} as const satisfies Record<string, NodeTintFacet>
