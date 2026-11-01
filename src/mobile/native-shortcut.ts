/**
 * A shortcut file the Mac signed, handed to Shortcuts by the iPhone app
 * (`NativeShortcutImport.swift`): it fetches the file and puts up iOS's Open
 * In sheet, where Shortcuts opens it and offers Add Shortcut. Shortcuts'
 * own import link takes only iCloud links, so a page cannot do this itself.
 *
 *   page → app:  `{id, url, name}`
 *   app → page:  `spacetermNativeShortcut.reply(id, {opened: true} | {error})`
 */

interface NativeShortcutReply {
  opened?: boolean
  error?: string
}

declare global {
  interface Window {
    spacetermNativeShortcut?: { reply(id: string, answer: NativeShortcutReply): void }
  }
}

const pending = new Map<string, (answer: NativeShortcutReply) => void>()
let nextId = 0

/** The app's fetch of the file, over Tailscale, and the sheet: well within this. */
const NATIVE_TIMEOUT_MS = 30_000

/** Whether this is an app that can open a shortcut: false in Safari, or in an app built before this existed. */
export function nativeShortcutAvailable(): boolean {
  return window.webkit?.messageHandlers?.nativeShortcut !== undefined
}

/** Have the app offer the shortcut at `url` to Shortcuts. Rejects with a reason worded for the user. */
export function openShortcutNatively(url: string, name: string): Promise<void> {
  const handler = window.webkit?.messageHandlers?.nativeShortcut
  if (!handler) return Promise.reject(new Error('this iPhone app is too old to add shortcuts; install the app update first'))
  window.spacetermNativeShortcut ??= {
    reply: (id, answer) => {
      const settle = pending.get(id)
      pending.delete(id)
      settle?.(answer)
    },
  }
  const id = String(++nextId)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('the iPhone app took too long to fetch the shortcut'))
    }, NATIVE_TIMEOUT_MS)
    pending.set(id, (answer) => {
      clearTimeout(timer)
      if (answer.opened) resolve()
      else reject(new Error(answer.error ?? 'the iPhone app could not open the shortcut'))
    })
    handler.postMessage({ id, url, name })
  })
}
