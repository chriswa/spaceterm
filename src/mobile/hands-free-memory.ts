/**
 * Whether hands-free was on, kept across what should not turn it off: a
 * server restart (which reloads the page), a reload, the desktop client or the
 * iPhone app relaunching. Not across the iPhone app being replaced: what is
 * kept names the app's build (`window.spacetermNativeVersion`), and a
 * different one finds nothing — a new app starts with hands-free off.
 *
 * `localStorage`, guarded: a private window, or storage turned off, simply
 * remembers nothing.
 */

import { browserStorage, type MemoryStorage } from './browser-storage'

const KEY = 'spaceterm.handsFree'

/** Remember hands-free on (for this build) or off. */
export function rememberHandsFree(on: boolean, build: string, store: MemoryStorage | null = browserStorage()): void {
  try {
    if (on) store?.setItem(KEY, JSON.stringify({ build }))
    else store?.removeItem(KEY)
  } catch { /* nothing to remember with */ }
}

/** Whether hands-free was on when this build last ran. */
export function rememberedHandsFree(build: string, store: MemoryStorage | null = browserStorage()): boolean {
  try {
    const kept = JSON.parse(store?.getItem(KEY) ?? 'null') as { build?: unknown } | null
    return kept?.build === build
  } catch {
    return false
  }
}
