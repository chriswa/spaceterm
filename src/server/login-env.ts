import { execFile } from 'child_process'
import { watchFile, unwatchFile, type Stats } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { serverLog } from './server-log'
import { scrubInheritedAgentEnv } from './spawn-env'

/**
 * The environment a new terminal tab would have right now, for PTYs that run a
 * command directly instead of a shell.
 *
 * The server's own `process.env` is a snapshot of whatever shell launched it,
 * possibly weeks ago, and the restart loop re-execs it with that same snapshot.
 * A shell surface doesn't care — it runs `$SHELL -l` in a TTY and re-reads the
 * rc files — but a Claude/Cursor/Codex surface is exec'd straight from the
 * server's env, so an `export` added to `~/.zshrc` never reaches it.
 *
 * Capturing means running `$SHELL -l -i` once (about a second with nvm and
 * friends in the rc files), so it happens in the background and `current()`
 * never blocks a spawn: it returns the last capture, or null before the first
 * one lands. A refresh runs at construction, whenever a startup file changes,
 * and after every spawn, which also picks up files the rc files source
 * indirectly and `launchctl setenv` by the next spawn.
 */
export interface LoginEnvSource {
  /** The last captured environment, or null if none has succeeded yet. */
  current(): Record<string, string> | null
  /** Start a background re-capture, or queue one if a capture is already running. */
  refresh(): void
  dispose(): void
}

/** Printed before `env -0` so rc-file chatter on stdout can't be parsed as variables. */
const MARKER = '__SPACETERM_LOGIN_ENV__'

/** Set by the capturing shell itself, not by the user's configuration. */
const SHELL_OWN_VARS = new Set(['PWD', 'OLDPWD', 'SHLVL', '_'])

type StatListener = (cur: Stats, prev: Stats) => void

const CAPTURE_TIMEOUT_MS = 10_000
const RC_POLL_INTERVAL_MS = 2_000

/** Startup files a login interactive shell reads, by shell name. */
function startupFiles(shell: string, home: string): string[] {
  switch (basename(shell)) {
    case 'zsh': {
      const zdot = process.env.ZDOTDIR || home
      return ['.zshenv', '.zprofile', '.zshrc', '.zlogin'].map((f) => join(zdot, f))
    }
    case 'bash':
      return ['.bash_profile', '.bash_login', '.profile', '.bashrc'].map((f) => join(home, f))
    default:
      return ['.profile'].map((f) => join(home, f))
  }
}

/** Parse `printf '\0MARKER\0'; env -0` output into a variable map. */
export function parseCapturedEnv(stdout: string): Record<string, string> | null {
  const start = stdout.indexOf(`\0${MARKER}\0`)
  if (start === -1) return null
  const env: Record<string, string> = {}
  for (const entry of stdout.slice(start + MARKER.length + 2).split('\0')) {
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    const key = entry.slice(0, eq)
    if (!SHELL_OWN_VARS.has(key)) env[key] = entry.slice(eq + 1)
  }
  return env
}

export class LoginShellEnv implements LoginEnvSource {
  private captured: Record<string, string> | null = null
  private inFlight = false
  private again = false
  private readonly watched: Array<{ file: string; listener: StatListener }>

  constructor(private readonly shell: string = process.env.SHELL || '/bin/zsh') {
    // Polling rather than fs.watch: editors save by renaming over the file,
    // which silently ends an fs.watch on the old inode.
    this.watched = startupFiles(shell, process.env.HOME || homedir()).map((file) => {
      const listener: StatListener = (cur, prev) => {
        if (cur.mtimeMs !== prev.mtimeMs) this.refresh()
      }
      watchFile(file, { interval: RC_POLL_INTERVAL_MS, persistent: false }, listener)
      return { file, listener }
    })
    this.refresh()
  }

  current(): Record<string, string> | null {
    return this.captured
  }

  refresh(): void {
    // A change that lands mid-capture may have been read too late, so run once
    // more afterwards rather than dropping it.
    if (this.inFlight) {
      this.again = true
      return
    }
    this.inFlight = true
    const child = execFile(
      this.shell,
      ['-l', '-i', '-c', `printf '\\0${MARKER}\\0'; env -0`],
      {
        env: scrubInheritedAgentEnv(process.env),
        cwd: process.env.HOME || homedir(),
        timeout: CAPTURE_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      },
      (err, stdout) => {
        const env = err ? null : parseCapturedEnv(stdout)
        if (env) {
          this.captured = env
        } else {
          serverLog(`[login-env] capture from ${this.shell} failed: ${err?.message ?? 'no marker in output'}`)
        }
        this.inFlight = false
        if (this.again) {
          this.again = false
          this.refresh()
        }
      }
    )
    // An interactive shell that reads stdin would otherwise wait on it forever.
    child.stdin?.end()
  }

  dispose(): void {
    for (const { file, listener } of this.watched) unwatchFile(file, listener)
  }
}
