import type { AgentIndicatorKind } from './crab-nav'

/**
 * A hat worn by an agent's mark to say which model family the surface runs.
 *
 * Opus is the operator's everyday model and wears nothing, so a hat only
 * appears when a surface is running something else.
 */
export type ModelHat = 'crown' | 'cap' | 'dunce'

export const HAT_COLORS: Record<ModelHat, string> = {
  crown: '#ffd700',
  cap: '#3b82f6',
  dunce: '#9b4dff',
}

const HAT_BY_FAMILY: Record<string, ModelHat | null> = {
  opus: null,
  fable: 'crown',
  sonnet: 'cap',
  haiku: 'dunce',
}

/**
 * The hat for a surface, from the model name its agent reports (a display name
 * such as "Sonnet 5.5"). Any agent running a Claude model wears one — Cursor
 * can — and anything else, unknown or missing wears nothing rather than a guess.
 */
export function modelHat(kind: AgentIndicatorKind, model: string | undefined): ModelHat | null {
  if (kind === 'terminal' || !model) return null
  const family = model.toLowerCase().match(/\b(opus|fable|sonnet|haiku)\b/)?.[1]
  return family ? HAT_BY_FAMILY[family] : null
}
