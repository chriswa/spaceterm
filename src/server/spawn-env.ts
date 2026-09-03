/**
 * Environment variables an agent CLI stamps on the processes it spawns to mark
 * them as *its* children. They describe one specific session — its pid, its
 * transcript id, its messaging socket — and are meaningless, or actively
 * harmful, in any process that session did not spawn.
 *
 * They leak into Spaceterm whenever the server (or SpacetermBar — see
 * `menubar/Sources/SpacetermBar/Spawn.swift`, which mirrors this list) is
 * started from inside an agent: `npm run dev` in a Claude Code Bash tool, or
 * `open SpacetermBar.app` from one, since macOS `open` forwards the caller's
 * environment. Every PTY then inherits them, and each new Claude Code session
 * sees `CLAUDE_CODE_CHILD_SESSION=1`, decides it is a nested child of a
 * session that never spawned it, and turns off transcript saving.
 *
 * Only session-identity variables are listed. User configuration such as
 * `CLAUDE_CONFIG_DIR` or `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE` is deliberately
 * forwarded, because the user set it for exactly these shells.
 */
export const INHERITED_AGENT_SESSION_VARS: readonly string[] = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SSE_PORT',
]

/** A copy of `env` without another agent session's identity variables. */
export function scrubInheritedAgentEnv(
  env: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || INHERITED_AGENT_SESSION_VARS.includes(key)) continue
    out[key] = value
  }
  return out
}
