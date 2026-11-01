/**
 * Setting up the iPhone's Action button for hands-free's "dictate …" — the
 * toolbar sheet's button (ActionButtonSetupButton, toolbar/buttons.tsx).
 *
 * The Mac makes and signs the shortcut (src/server/action-button-shortcut.ts)
 * and serves it; the iPhone app fetches it and offers it to Shortcuts
 * (native-shortcut.ts): tap Shortcuts, then Add Shortcut. Shortcuts' own
 * import link was tried first and refused it — it takes only iCloud links —
 * and Safari only offered to download it, so neither is used. Choosing it for
 * the Action button is Settings' alone — no app can — so the last word says
 * where.
 */

import { showToast } from '@/lib/toast'
import { openShortcutNatively } from './native-shortcut'

export const SHORTCUT_NAME = 'Copy Last Dictation'

export interface ActionButtonSetupDeps {
  prepare(): Promise<{ ok: boolean; urlPath?: string; message?: string }>
  /** Offer the shortcut at `url` to Shortcuts; rejects with a reason worded for the user. */
  openInShortcuts(url: string, name: string): Promise<void>
  /** This page's origin, which serves the shortcut. */
  origin: string
  toast(message: string): void
  log(message: string): void
}

export async function setUpActionButton(deps: ActionButtonSetupDeps): Promise<void> {
  try {
    const prepared = await deps.prepare()
    if (!prepared.ok || !prepared.urlPath) {
      deps.toast(prepared.message ?? 'The Mac could not make the shortcut.')
      return
    }
    deps.log(`[action-button] offering ${prepared.urlPath} to Shortcuts`)
    await deps.openInShortcuts(deps.origin + prepared.urlPath, SHORTCUT_NAME)
    deps.toast(`Tap Shortcuts, then Add Shortcut. Then pick “${SHORTCUT_NAME}” in Settings → Action Button → Shortcut.`)
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    deps.log(`[action-button] could not offer the shortcut: ${why}`)
    deps.toast(`Could not set up the Action button: ${why}`)
  }
}

export function realActionButtonSetupDeps(): ActionButtonSetupDeps {
  return {
    prepare: () => window.api.actionButtonShortcut(),
    openInShortcuts: openShortcutNatively,
    origin: window.location.origin,
    toast: showToast,
    log: (message) => window.api.log(message),
  }
}
