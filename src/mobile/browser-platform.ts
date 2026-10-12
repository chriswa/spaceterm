import type { PlatformApi } from '../shared/api'
import { DEFAULT_LAUNCH_PREFS } from '../shared/launch-prefs'
import { createGate } from './gate'

/**
 * The host half of `window.api` in a browser. Everything server-facing is
 * shared with the desktop; this is only what Electron's main process would
 * otherwise provide, and most of it has no meaning on a phone.
 *
 * Logs are kept in memory (`window.spacetermLog`) and, once connected, sent to
 * the server's log (see `forwardLogs`): there is no file to write here, and a
 * phone's console is not somewhere anyone will look.
 */

const LOG_LIMIT = 500
const logBuffer: string[] = []

/** Where log lines also go once the page has a server to send them to. */
let forward: ((message: string) => void) | null = null

/**
 * Also send every log line to the server's log, starting with what was
 * buffered before the connection — so the phone's logs can be read on the Mac.
 */
export function forwardLogs(send: (message: string) => void): void {
  forward = send
  logBuffer.forEach(send)
}

declare global {
  interface Window {
    spacetermLog?: string[]
  }
}

function log(message: string): void {
  logBuffer.push(`${new Date().toISOString()} ${message}`)
  if (logBuffer.length > LOG_LIMIT) logBuffer.splice(0, logBuffer.length - LOG_LIMIT)
  window.spacetermLog = logBuffer
  forward?.(message)
}

/**
 * Whether the canvas is hidden behind a full-screen view: the terminal, or
 * Control's transcript (control-mode.ts). The renderer pauses every canvas
 * loop — background, thumbnails, the rest — when told the window is not
 * visible; a canvas nobody can see under a full-screen view is, for that
 * purpose, not visible. Each view covers it separately, so closing one never
 * uncovers it while the other is still up.
 */
export type CanvasCover = 'terminal' | 'control'
const coveredBy = new Set<CanvasCover>()

/** The page is hidden: the screen off, or another app in front. */
export const pageHidden = createGate(typeof document !== 'undefined' && document.visibilityState === 'hidden')
/** The canvas is on screen: the page visible and nothing covering it. */
export const canvasOnScreen = createGate(!pageHidden.on)
const visibilityListeners = new Set<(visible: boolean) => void>()
const announceVisibility = () => {
  canvasOnScreen.set(!pageHidden.on && coveredBy.size === 0)
  visibilityListeners.forEach((cb) => cb(canvasOnScreen.on))
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    pageHidden.set(document.visibilityState === 'hidden')
    announceVisibility()
  })
}

export function setCanvasCovered(by: CanvasCover, covered: boolean): void {
  if (covered === coveredBy.has(by)) return
  if (covered) coveredBy.add(by)
  else coveredBy.delete(by)
  announceVisibility()
}

function listen(target: EventTarget, events: string[], read: () => boolean, callback: (value: boolean) => void): () => void {
  const handler = () => callback(read())
  events.forEach((e) => target.addEventListener(e, handler))
  return () => events.forEach((e) => target.removeEventListener(e, handler))
}

export function browserPlatform(): PlatformApi {
  return {
    log,
    writeDebugLog: async (content) => {
      log(content)
      return 'window.spacetermLog'
    },
    openExternal: async (url) => {
      if (/^https?:\/\//.test(url)) window.open(url, '_blank', 'noopener')
    },
    // Nothing to do here: the restarting server drops this page's connection,
    // and install-api reloads the page once it reconnects — which is to say
    // once the new server is actually up. Reloading on a timer instead raced
    // the server's start: the reload found nothing listening, the app's web
    // view was left on its load error, and with no page there was no script
    // left to try again — a black screen until the app was relaunched.
    restartClient: () => undefined,
    raiseWindow: () => undefined,
    onFocusRequest: () => () => undefined,
    perf: {
      startTrace: async () => undefined,
      stopTrace: async () => ''
    },
    window: {
      fitToWorkArea: async () => undefined,
      onVisibilityChanged: (cb) => {
        visibilityListeners.add(cb)
        return () => { visibilityListeners.delete(cb) }
      },
      onFocusChanged: (cb) =>
        listen(window, ['focus', 'blur'], () => document.hasFocus(), cb)
    },
    system: {
      setMetricsEnabled: () => undefined,
      onMetrics: () => () => undefined,
      getLaunchPrefs: async () => DEFAULT_LAUNCH_PREFS,
      setLaunchPrefs: async () => DEFAULT_LAUNCH_PREFS,
      getActiveLaunchPrefs: async () => DEFAULT_LAUNCH_PREFS
    }
  }
}
