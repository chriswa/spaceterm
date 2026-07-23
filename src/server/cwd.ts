import { homedir } from 'os'
import { join } from 'path'

/**
 * Expand a leading `~` / `~/…` to an absolute path under the user's home.
 *
 * CLI agents receive their working directory two different ways: Claude inherits
 * the PTY's working directory (which the daemon sets from CreateOptions.cwd),
 * while Cursor (`--workspace`) and Codex (`-C`) take it as a command-line
 * argument. Shell tilde-expansion never runs for either, so a stored cwd like
 * `~/spaceterm` must be expanded here before it is used as a PTY cwd OR an argv
 * entry — otherwise the agent gets a literal `~` and dies with "directory does
 * not exist". Keep this the single expansion point so those paths can't diverge.
 */
export function expandTilde(p: string | undefined): string | undefined {
  if (!p) return p
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}
