import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { SOCKET_DIR } from '../../shared/protocol'
import { DEFAULT_LAUNCH_PREFS, type LaunchPrefs } from '../../shared/launch-prefs'
import { writeFileAtomicSync } from './atomic-write'

/**
 * Persistence for the pre-launch settings in `shared/launch-prefs`.
 *
 * Read synchronously, because the only useful moment to read it is before
 * `app.commandLine` is finalised — there is no window to await at that point.
 * Written with `writeFileAtomicSync`: a torn file here would be read at the
 * next launch, which is the one time nothing is around to recover from it.
 */

const PREFS_FILE = join(SOCKET_DIR, 'launch-prefs.json')

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
  writeFileAtomicSync(PREFS_FILE, JSON.stringify(next, null, 2))
  return next
}
