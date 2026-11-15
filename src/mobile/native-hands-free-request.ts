/**
 * "Hey Siri, Space term": the iPhone app's Start Hands-Free intent
 * (`HandsFreeIntents.swift`) opens the app — launching it if need be — and
 * asks this page to turn hands-free on. The page may not exist yet when Siri
 * asks (a cold launch, the Mac still being found), so the app keeps the
 * request and the page says when it can take one.
 *
 *   page → app:  `{ready: true}`, once the page can start hands-free
 *   app → page:  `spacetermHandsFreeRequest.start()`, as many times as asked
 *
 * Nothing in a browser, or in an app built before this existed.
 */

declare global {
  interface Window {
    spacetermHandsFreeRequest?: { start(): void }
  }
}

/** Take the app's requests to start hands-free, by calling `start`; the returned function stops. */
export function installHandsFreeRequests(start: () => void, host: Window = window): () => void {
  const handler = host.webkit?.messageHandlers?.nativeHandsFreeRequest
  if (!handler) return () => {}
  const taker = { start }
  host.spacetermHandsFreeRequest = taker
  // A request that came before the page did is handed over now.
  handler.postMessage({ ready: true })
  return () => {
    if (host.spacetermHandsFreeRequest === taker) delete host.spacetermHandsFreeRequest
  }
}
