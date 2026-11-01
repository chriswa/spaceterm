/**
 * The phone's last "dictate …", kept by the iPhone app (`NativeDictation.swift`)
 * for its Action button: iOS lets no app set the clipboard from the
 * background, but a shortcut can — the app's "Get Last Dictation", then
 * Shortcuts' own Copy to Clipboard (action-button-setup.ts). The app copies
 * it at once as well when it is in front.
 *
 *   page → app:  `{text}`
 *
 * False in a browser, or in an app built before this existed: nothing kept it.
 */
export function keepNativeDictation(text: string): boolean {
  const handler = window.webkit?.messageHandlers?.nativeDictation
  if (!handler) return false
  handler.postMessage({ text })
  return true
}
