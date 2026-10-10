import { accessSync, constants, statSync } from 'fs'
import { join } from 'path'

/**
 * Resolve a bare command name against the PATH of the environment it will run
 * in, rather than the PATH of whoever ends up exec'ing it.
 *
 * The PTY daemon execs commands with Go's `exec.Command`, which looks a bare
 * name up on the *daemon's own* PATH — not the env it is handed. The daemon is
 * long-lived (it outlives server restarts precisely so terminals survive), so
 * its PATH is whatever the server had the day the daemon first started. A
 * `claude` that is only on PATH via `~/.zshrc` (nvm, `~/.local/bin`) then fails
 * with "executable file not found" even though every terminal tab finds it.
 * Resolving here, against the login environment the PTY actually receives,
 * makes a command surface find exactly what a shell surface would.
 *
 * A name containing `/` is returned as-is, as is a name not found on `pathVar`
 * — the daemon's own lookup then still gets its chance, so this can only widen
 * what resolves, never narrow it.
 */
export function resolveOnPath(
  command: string,
  pathVar: string | undefined,
  isExecutable: (file: string) => boolean = isExecutableFile
): string {
  if (command.includes('/') || !pathVar) return command
  for (const dir of pathVar.split(':')) {
    // An empty PATH entry means the current directory; never resolve a
    // command surface relative to the server's cwd.
    if (!dir) continue
    const candidate = join(dir, command)
    if (isExecutable(candidate)) return candidate
  }
  return command
}

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}
