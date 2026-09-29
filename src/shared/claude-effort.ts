/**
 * How hard a Claude Code surface is thinking, as its status line reports it:
 * the `/effort` level, or `off` when thinking is disabled outright. Ordered
 * least to most, which is what `effortSteps` measures along.
 */
export const CLAUDE_EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ClaudeEffort = typeof CLAUDE_EFFORTS[number]

/**
 * Read the effort from a status-line payload, or `undefined` when it does not
 * say — an older Claude Code, another agent, or a level this list predates.
 */
export function parseClaudeEffort(payload: Record<string, unknown> | undefined): ClaudeEffort | undefined {
  const thinking = payload?.thinking as { enabled?: unknown } | undefined
  if (thinking?.enabled === false) return 'off'
  const level = (payload?.effort as { level?: unknown } | undefined)?.level
  return CLAUDE_EFFORTS.find(e => e !== 'off' && e === level)
}

/** Signed number of levels from `from` to `to`: positive when `to` thinks harder. */
export function effortSteps(from: ClaudeEffort, to: ClaudeEffort): number {
  return CLAUDE_EFFORTS.indexOf(to) - CLAUDE_EFFORTS.indexOf(from)
}
