import * as fs from 'fs'
import * as path from 'path'
import { SOCKET_DIR } from '../shared/protocol'

/**
 * A pending "the server must be restarted for on-disk changes to take effect"
 * signal.
 *
 * Raised by an agent (or a human) with `npm run flag-restart`, cleared when a
 * fresh server process starts. It exists because a change that needs a restart
 * — an edit to CLAUDE.md, server code, or the protocol — otherwise gets lost in
 * an agent's prose, and the human never restarts. The server watches for it and
 * lights up the client's Restart button; the human, not the agent, does the
 * actual restart.
 *
 * Persisted as a single file under `~/.spaceterm/` so it outlives both the agent
 * process that raised it and any client that surfaces it. Presence means a
 * restart is required; absence means it is not. There is no multi-request
 * accounting — the flag is one bit plus a human-readable reason.
 */
export interface RestartFlag {
  /** Human-readable why, shown in the Restart button's tooltip. May be ''. */
  reason: string
  /** When the flag was raised (epoch ms). */
  requestedAt: number
}

export function restartFlagPath(dir: string = SOCKET_DIR): string {
  return path.join(dir, 'restart-required.json')
}

/** The current flag, or `null` when no restart is pending. */
export function readRestartFlag(dir: string = SOCKET_DIR): RestartFlag | null {
  let raw: string
  try {
    raw = fs.readFileSync(restartFlagPath(dir), 'utf8')
  } catch {
    return null // absent = no restart pending
  }
  try {
    const parsed = JSON.parse(raw) as Partial<RestartFlag>
    return {
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      requestedAt: typeof parsed.requestedAt === 'number' ? parsed.requestedAt : 0
    }
  } catch {
    // A corrupt file still means someone asked for a restart; surface it rather
    // than pretend nothing was requested.
    return { reason: '', requestedAt: 0 }
  }
}

/** Raise the flag. `dir`/`now` are seams for tests. */
export function writeRestartFlag(
  reason: string,
  dir: string = SOCKET_DIR,
  now: number = Date.now()
): void {
  fs.mkdirSync(dir, { recursive: true })
  const flag: RestartFlag = { reason, requestedAt: now }
  fs.writeFileSync(restartFlagPath(dir), JSON.stringify(flag, null, 2))
}

/** Clear the flag. A no-op when it was never set. */
export function clearRestartFlag(dir: string = SOCKET_DIR): void {
  try {
    fs.unlinkSync(restartFlagPath(dir))
  } catch {
    // Already absent — nothing to clear.
  }
}

/**
 * Watch a directory, invoking `onEvent` with the changed filename (or `null`
 * when the platform does not report one) on each change. Returns a disposer.
 *
 * This is the seam between {@link watchRestartFlag}'s filter/re-read logic and
 * the OS: the real implementation is `fs.watch`, and a test injects a fake so it
 * can drive events deterministically rather than race filesystem-event delivery.
 */
export type WatchDir = (dir: string, onEvent: (filename: string | null) => void) => () => void

const realWatchDir: WatchDir = (dir, onEvent) => {
  const watcher = fs.watch(dir, (_event, filename) => onEvent(filename))
  watcher.on('error', () => {
    // Directory may have been removed out from under us.
  })
  return () => watcher.close()
}

/**
 * Watch for the flag appearing, changing, or being removed, calling `onChange`
 * with the current state each time. Returns a disposer.
 *
 * Watches the parent directory rather than the file so a flag that does not
 * exist yet is still caught when it is created — the same reason
 * `session-file-watcher.ts` watches the parent for a not-yet-created file.
 * `~/.spaceterm/` always exists in practice (the server's sockets live there),
 * but it is created defensively so a first run before any socket is bound still
 * arms the watch.
 */
export function watchRestartFlag(
  onChange: (flag: RestartFlag | null) => void,
  dir: string = SOCKET_DIR,
  watchDir: WatchDir = realWatchDir
): () => void {
  const fileName = path.basename(restartFlagPath(dir))
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    // Directory missing and could not be created — the watch below will throw.
  }
  let dispose: (() => void) | null = null
  try {
    dispose = watchDir(dir, (changed) => {
      // Some platforms report the changed filename as null; when they do,
      // re-read rather than risk missing the transition.
      if (changed !== null && changed !== fileName) return
      onChange(readRestartFlag(dir))
    })
  } catch {
    // Nothing to watch — leave the disposer a no-op.
  }
  return () => {
    if (dispose) {
      dispose()
      dispose = null
    }
  }
}
