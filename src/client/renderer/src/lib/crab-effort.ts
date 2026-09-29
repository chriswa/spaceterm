import { effortSteps, type ClaudeEffort } from '../../../../shared/claude-effort'
import type { AgentIndicatorKind } from './crab-nav'

/**
 * The operator's everyday effort level. A crab thinking at this level shows
 * nothing; one above or below it shows a plus or minus per level of difference.
 */
export const DEFAULT_EFFORT: ClaudeEffort = 'high'

/** Most signs drawn on one side, which is as far as any level can be from a default. */
export const MAX_EFFORT_SIGNS = 3

/**
 * Levels between a surface's effort and `DEFAULT_EFFORT`: positive when it
 * thinks harder, zero when it matches or does not say. Claude surfaces only.
 */
export function crabEffortSteps(kind: AgentIndicatorKind, effort: ClaudeEffort | undefined): number {
  if (kind !== 'claude' || !effort) return 0
  const steps = effortSteps(DEFAULT_EFFORT, effort)
  return Math.max(-MAX_EFFORT_SIGNS, Math.min(MAX_EFFORT_SIGNS, steps))
}
