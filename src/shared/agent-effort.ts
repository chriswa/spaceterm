import type { AgentType } from './agent-type'

/**
 * How hard each agent can be told to think, least to most, which is what
 * `effortSteps` measures along. Claude Code's scale adds `off` for thinking
 * disabled outright. Cursor runs other vendors' models under the same names,
 * so it shares Claude's. Codex has its own.
 */
export const EFFORT_SCALES = {
  claude: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
  cursor: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
} as const satisfies Record<AgentType, readonly string[]>

/** A level on some agent's scale; which one depends on the surface's agent. */
export type AgentEffort = typeof EFFORT_SCALES[AgentType][number]

const STATUS_LINE_SCALE: readonly string[] = EFFORT_SCALES.claude

/**
 * Read the effort from a status-line payload, which Claude Code and Cursor
 * both send. Claude Code states it as `effort.level` and `thinking.enabled`;
 * Cursor folds it into the model's `param_summary` ("High Fast") or display
 * name. `undefined` when the payload does not say.
 */
export function parseStatusLineEffort(payload: Record<string, unknown> | undefined): AgentEffort | undefined {
  const thinking = payload?.thinking as { enabled?: unknown } | undefined
  if (thinking?.enabled === false) return 'off'
  const level = (payload?.effort as { level?: unknown } | undefined)?.level
  if (typeof level === 'string' && level !== 'off' && STATUS_LINE_SCALE.includes(level)) return level as AgentEffort

  const model = payload?.model as { param_summary?: unknown; display_name?: unknown } | undefined
  for (const text of [model?.param_summary, model?.display_name]) {
    if (typeof text !== 'string') continue
    const word = text.toLowerCase().replace(/\bextra[\s-]?high\b/, 'xhigh').match(/\b(low|medium|high|xhigh|max)\b/)?.[1]
    if (word) return word as AgentEffort
  }
  return undefined
}

/** Read the effort from a Codex rollout `turn_context` payload. */
export function parseCodexEffort(payload: Record<string, unknown> | undefined): AgentEffort | undefined {
  const effort = payload?.effort
  const scale: readonly string[] = EFFORT_SCALES.codex
  return typeof effort === 'string' && scale.includes(effort) ? effort as AgentEffort : undefined
}

/**
 * Signed number of levels from `from` to `to` on `agent`'s scale: positive
 * when `to` thinks harder, zero when either is not on that scale.
 */
export function effortSteps(agent: AgentType, from: AgentEffort, to: AgentEffort): number {
  const scale: readonly string[] = EFFORT_SCALES[agent]
  const a = scale.indexOf(from)
  const b = scale.indexOf(to)
  return a < 0 || b < 0 ? 0 : b - a
}
