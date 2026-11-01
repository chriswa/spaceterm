/**
 * Setting up the iPhone's Action button for hands-free's "dictate …" — the
 * toolbar sheet's button (ActionButtonSetupButton, toolbar/buttons.tsx).
 *
 * The Mac makes and signs the shortcut (src/server/action-button-shortcut.ts)
 * and serves it; this opens Shortcuts' import link to it, which puts up its
 * Add Shortcut sheet. Whether Shortcuts fetched the file says whether that
 * worked: if it did not by the time the user is back here, or the page was
 * never left at all, the file is opened in Safari instead, which offers it to
 * Shortcuts as a download. Choosing it for the Action button is Settings'
 * alone — no app can — so the last word says where.
 */

import { showToast } from '@/lib/toast'

export const SHORTCUT_NAME = 'Copy Last Dictation'

/** How long to wait for the import link to take the page away before trying Safari. */
export const LEAVE_WAIT_MS = 3_000

export interface ActionButtonSetupDeps {
  prepare(): Promise<{ ok: boolean; urlPath?: string; message?: string }>
  fetched(): Promise<boolean>
  /** Open a link outside the page: the app hands any other scheme or host to iOS. */
  open(url: string): void
  /** This page's origin, which serves the shortcut. */
  origin: string
  /** Inside the iPhone app, where `x-safari-` reaches Safari; in Safari itself the file is simply opened. */
  inApp: boolean
  /** Call `fn` once, when the page next comes back after being hidden — or after `ms` if it was never hidden. */
  whenBack(ms: number, fn: (left: boolean) => void): void
  toast(message: string): void
  log(message: string): void
}

export async function setUpActionButton(deps: ActionButtonSetupDeps): Promise<void> {
  let prepared: { ok: boolean; urlPath?: string; message?: string }
  try {
    prepared = await deps.prepare()
  } catch (err) {
    deps.toast(`Could not make the shortcut: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  if (!prepared.ok || !prepared.urlPath) {
    deps.toast(prepared.message ?? 'The Mac could not make the shortcut.')
    return
  }
  const fileUrl = deps.origin + prepared.urlPath
  deps.log(`[action-button] opening Shortcuts' import link to ${prepared.urlPath}`)
  deps.whenBack(LEAVE_WAIT_MS, (left) => {
    void deps.fetched().then((fetched) => {
      if (fetched) {
        deps.log('[action-button] Shortcuts fetched the shortcut')
        deps.toast(`Now pick “${SHORTCUT_NAME}” in Settings → Action Button → Shortcut.`)
        return
      }
      deps.log(`[action-button] Shortcuts never fetched it (${left ? 'came back' : 'never left'}): opening it in Safari`)
      deps.open(deps.inApp ? `x-safari-${fileUrl}` : fileUrl)
    }, (err) => deps.toast(`Could not ask the Mac about the shortcut: ${err instanceof Error ? err.message : String(err)}`))
  })
  deps.open(`shortcuts://import-shortcut?url=${encodeURIComponent(fileUrl)}&name=${encodeURIComponent(SHORTCUT_NAME)}`)
}

/** `whenBack` for a real page: hidden then visible again, or `ms` without ever being hidden. */
export function realWhenBack(ms: number, fn: (left: boolean) => void): void {
  let left = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let onChange = () => {}
  const finish = () => {
    clearTimeout(timer)
    document.removeEventListener('visibilitychange', onChange)
    fn(left)
  }
  onChange = () => {
    if (document.visibilityState === 'hidden') {
      left = true
      clearTimeout(timer)
      return
    }
    if (left) finish()
  }
  timer = setTimeout(finish, ms)
  document.addEventListener('visibilitychange', onChange)
}

export function realActionButtonSetupDeps(): ActionButtonSetupDeps {
  return {
    prepare: () => window.api.actionButtonShortcut(),
    fetched: () => window.api.actionButtonShortcutFetched(),
    open: (url) => { window.location.href = url },
    origin: window.location.origin,
    inApp: navigator.userAgent.includes('SpacetermApp/'),
    whenBack: realWhenBack,
    toast: showToast,
    log: (message) => window.api.log(message),
  }
}
