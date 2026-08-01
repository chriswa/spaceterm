/**
 * The agent CLIs a terminal surface can run.
 *
 * This union used to be written out inline in ten places across the server, the
 * renderer and the protocol, which is why adding Cursor and Codex touched 37
 * files. Naming it once is the first half of the fix; `AgentDriver` on the
 * server is the other half.
 */
export type AgentType = 'claude' | 'cursor' | 'codex'

/** Every agent type, in display order. */
export const AGENT_TYPES: readonly AgentType[] = ['claude', 'cursor', 'codex']

/** Human-readable name, for log lines and UI. */
export const AGENT_LABELS: Record<AgentType, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex'
}

export function isAgentType(value: unknown): value is AgentType {
  return typeof value === 'string' && (AGENT_TYPES as readonly string[]).includes(value)
}

/**
 * A surface with no recorded `agentType` predates the field and is Claude —
 * the only agent that existed then.
 */
export function agentTypeOrDefault(value: AgentType | undefined): AgentType {
  return value ?? 'claude'
}

/** Display name for a surface, defaulting the way {@link agentTypeOrDefault} does. */
export function agentLabel(value: AgentType | undefined): string {
  return AGENT_LABELS[agentTypeOrDefault(value)]
}
