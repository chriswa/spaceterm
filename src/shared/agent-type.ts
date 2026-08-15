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

/**
 * The executable each agent is launched as, and therefore the `comm` its
 * process reports. `AgentDriver.buildCreateOptions` spawns these as the PTY's
 * top-level process, so on an agent surface this name identifies the PTY root.
 *
 * Named here rather than written inline in the drivers because the MCP server
 * runs out-of-process and has to recognise these names without importing any
 * server code — two copies of the list would drift the first time a CLI is
 * renamed, and the failure would be a self-terminate that silently finds
 * nothing.
 */
export const AGENT_PTY_COMMANDS: Record<AgentType, string> = {
  claude: 'claude',
  cursor: 'agent',
  codex: 'codex'
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
