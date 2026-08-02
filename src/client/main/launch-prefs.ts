import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { SOCKET_DIR } from '../../shared/protocol'
import { DEFAULT_LAUNCH_PREFS, type LaunchPrefs } from '../../shared/launch-prefs'

/**
 * Persistence for the pre-launch settings in `shared/launch-prefs`.
 *
 * Read synchronously, because the only useful moment to read it is before
 * `app.commandLine` is finalised — there is no window to await at that point.
 * Written with the same write-temp-fsync-rename dance as `window-state.ts`: a
 * torn file here would be read at the next launch, which is the one time
 * nothing is around to recover from it.
 */

const PREFS_FILE = join(SOCKET_DIR, 'launch-prefs.json')
const PREFS_TMP = PREFS_FILE + '.tmp'

/** The stored prefs, with defaults for anything missing or malformed. */
export function loadLaunchPrefs(): LaunchPrefs {
  if (!existsSync(PREFS_FILE)) return { ...DEFAULT_LAUNCH_PREFS }
  try {
    const parsed: unknown = JSON.parse(readFileSync(PREFS_FILE, 'utf-8'))
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_LAUNCH_PREFS }
    const raw = parsed as Partial<Record<keyof LaunchPrefs, unknown>>
    return {
      highPerformanceGpu: typeof raw.highPerformanceGpu === 'boolean'
        ? raw.highPerformanceGpu
        : DEFAULT_LAUNCH_PREFS.highPerformanceGpu,
    }
  } catch {
    return { ...DEFAULT_LAUNCH_PREFS }
  }
}

/** Merge `patch` over the stored prefs and persist. Returns what is now stored. */
export function saveLaunchPrefs(patch: Partial<LaunchPrefs>): LaunchPrefs {
  const next: LaunchPrefs = { ...loadLaunchPrefs(), ...patch }
  mkdirSync(dirname(PREFS_FILE), { recursive: true })
  writeFileSync(PREFS_TMP, JSON.stringify(next, null, 2), 'utf-8')
  const fd = openSync(PREFS_TMP, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(PREFS_TMP, PREFS_FILE)
  return next
}
