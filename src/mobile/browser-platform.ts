import type { PlatformApi } from '../shared/api'
import { DEFAULT_LAUNCH_PREFS } from '../shared/launch-prefs'

/**
 * The host half of `window.api` in a browser. Everything server-facing is
 * shared with the desktop; this is only what Electron's main process would
 * otherwise provide, and most of it has no meaning on a phone.
 *
 * Logs stay in memory (`window.spacetermLog`): there is no file to write, and
 * a page's console is not somewhere anyone will look.
 */

const LOG_LIMIT = 500
const logBuffer: string[] = []

declare global {
  interface Window {
    spacetermLog?: string[]
  }
}

function log(message: string): void {
  logBuffer.push(`${new Date().toISOString()} ${message}`)
  if (logBuffer.length > LOG_LIMIT) logBuffer.splice(0, logBuffer.length - LOG_LIMIT)
  window.spacetermLog = logBuffer
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
    restartClient: () => window.setTimeout(() => window.location.reload(), 1500),
    raiseWindow: () => undefined,
    onFocusRequest: () => () => undefined,
    perf: {
      startTrace: async () => undefined,
      stopTrace: async () => ''
    },
    window: {
      fitToWorkArea: async () => undefined,
      onVisibilityChanged: (cb) =>
        listen(document, ['visibilitychange'], () => document.visibilityState === 'visible', cb),
      onFocusChanged: (cb) =>
        listen(window, ['focus', 'blur'], () => document.hasFocus(), cb)
    },
    system: {
      setMetricsEnabled: () => undefined,
      onMetrics: () => () => undefined,
      getLaunchPrefs: async () => DEFAULT_LAUNCH_PREFS,
      setLaunchPrefs: async () => DEFAULT_LAUNCH_PREFS,
      getActiveLaunchPrefs: async () => DEFAULT_LAUNCH_PREFS,
      getAgentMemory: async () => null
    }
  }
}
