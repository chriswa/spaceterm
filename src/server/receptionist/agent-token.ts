/**
 * How Control and the system refer to an agent: one token, the same in every
 * direction.
 *
 * `{amber-otter}` while the agent has no name, `{Kevin:amber-otter}` once it
 * has one. Every list, result, event and read header writes agents this way,
 * and everything that takes an agent from the model — what it says, who a
 * part is from, a tool's argument — reads it back the same way.
 *
 * The token exists because the model copies what it is shown. Shown a handle
 * and a name side by side ("[royal-anchor] Naomi"), it wrote both side by side
 * ("{royal-anchor}, Naomi,"), and the handle was then spoken as the name:
 * "Naomi, Naomi". One token carrying both gives it nothing to write twice.
 *
 * The handle is what picks the agent; the name in front of it is only what the
 * model last knew it as, and a stale one is spoken as the agent's real name.
 * A bare `{Kevin}` or `{amber-otter}` still works.
 */

/** A token in what the model wrote: `{Kevin:amber-otter}`, `{Kevin}` or `{amber-otter}`. Group 1 is what is inside the braces. */
export const AGENT_TOKEN = /\{([A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)?)\}/g

/** The token for an agent, as the system writes it. */
export function agentToken(handle: string, name?: string): string {
  return `{${name ? `${name}:` : ''}${handle}}`
}

/**
 * A reference as the model wrote it, braces or not. `key` is what picks the
 * agent: the handle after a colon, or else the whole reference, which may be
 * a handle or a name. `name` is the name written in front of a handle.
 */
export function parseAgentRef(written: string): { key: string; name?: string } {
  const bare = stripBraces(written)
  const colon = bare.indexOf(':')
  if (colon < 0) return { key: bare }
  return { name: bare.slice(0, colon).trim(), key: bare.slice(colon + 1).trim() }
}

/** `{amber-otter}` as `amber-otter`: a tool argument may be written as a token. */
export function stripBraces(written: string): string {
  const trimmed = written.trim()
  return trimmed.startsWith('{') && trimmed.endsWith('}') ? trimmed.slice(1, -1).trim() : trimmed
}
