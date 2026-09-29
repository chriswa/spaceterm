import { effortSteps, type AgentEffort } from '../../../../shared/agent-effort'
import type { AgentType } from '../../../../shared/agent-type'
import type { AgentIndicatorKind } from './crab-nav'

/**
 * The operator's everyday effort level per agent. A crab thinking at this
 * level shows nothing; one above or below it shows a plus or minus per level
 * of difference.
 */
export const DEFAULT_EFFORT: Record<AgentType, AgentEffort> = {
  claude: 'high',
  cursor: 'high',
  codex: 'medium',
}

/** Most signs drawn on one side, which is as far as any level can be from a default. */
export const MAX_EFFORT_SIGNS = 3

/**
 * Levels between a surface's effort and its agent's `DEFAULT_EFFORT`:
 * positive when it thinks harder, zero when it matches or does not say.
 */
export function crabEffortSteps(kind: AgentIndicatorKind, effort: AgentEffort | undefined): number {
  if (kind === 'terminal' || !effort) return 0
  const steps = effortSteps(kind, DEFAULT_EFFORT[kind], effort)
  return Math.max(-MAX_EFFORT_SIGNS, Math.min(MAX_EFFORT_SIGNS, steps))
}
