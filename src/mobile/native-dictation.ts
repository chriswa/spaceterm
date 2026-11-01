/**
 * The phone's last "dictate …", kept by the iPhone app (`NativeDictation.swift`)
 * for its Action button: iOS lets no app set the clipboard from the
 * background, but a shortcut can — the app's "Copy Last Dictation" or "Get
 * Last Dictation" action, then the shortcut's own Copy to Clipboard. The app
 * copies it at once as well when it is in front.
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
