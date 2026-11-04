/**
 * Put text on the phone's clipboard, through the iPhone app
 * (`NativeClipboard.swift`): the page is served over plain http on the
 * tailnet, not a secure context, so it has no `navigator.clipboard`.
 *
 *   page → app:  `{text}`
 *   app → page:  whether iOS took it
 */

interface ReplyingHandler {
  postMessage(message: unknown): Promise<unknown>
}

function handler(): ReplyingHandler | undefined {
  return window.webkit?.messageHandlers?.nativeClipboard as ReplyingHandler | undefined
}

/** False in a browser, or in an app built before this existed. */
export function nativeClipboardAvailable(): boolean {
  return handler() !== undefined
}

/** Resolves to whether the clipboard now holds `text`. */
export async function copyNatively(text: string): Promise<boolean> {
  const h = handler()
  if (!h) return false
  return (await h.postMessage({ text })) === true
}
