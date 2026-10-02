import { contextBridge, ipcRenderer } from 'electron'
// The bridge contract lives in src/shared/api.ts so the renderer type-checks
// against the same declaration this file implements. Do not restate it here.
import type { ElectronHost, ServerPipeEventKind } from '../../shared/api'
import type { SystemMetricsSample } from '../../shared/system-metrics'

/**
 * Electron's half of `window.api`: the window, the machine, and a pipe to the
 * server socket.
 *
 * Everything that talks to the server is assembled in the renderer from that
 * pipe by shared code (`src/shared/client-api.ts`), the same code the mobile
 * web app runs. This file used to relay each of ~100 calls by hand.
 */

/** Subscribe to one main→renderer channel; returns the unsubscribe. */
function listen<A extends unknown[]>(channel: string, callback: (...args: A) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// Annotated rather than passed inline so the object literal is checked against
// the contract: a missing member and an unknown member are both compile errors.
const host: ElectronHost = {
  platform: {
    log: (message: string) => ipcRenderer.send('log', message),
    writeDebugLog: (content: string): Promise<string> => ipcRenderer.invoke('debug:write-log', content),
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
    restartClient: () => ipcRenderer.send('app:restart-client'),
    raiseWindow: () => ipcRenderer.send('window:raise'),
    onFocusRequest: (callback: (id: string) => void) => listen('window:focus-request', callback),
    perf: {
      startTrace: () => ipcRenderer.invoke('perf:trace-start'),
      stopTrace: (): Promise<string> => ipcRenderer.invoke('perf:trace-stop')
    },
    window: {
      fitToWorkArea: (): Promise<void> => ipcRenderer.invoke('window:fit-to-work-area'),
      onVisibilityChanged: (callback: (visible: boolean) => void) => listen('window:visibility-changed', callback),
      onFocusChanged: (callback: (focused: boolean) => void) => listen('window:focus-changed', callback)
    },
    system: {
      setMetricsEnabled: (enabled: boolean) => ipcRenderer.send('system:set-metrics-enabled', enabled),
      onMetrics: (callback: (sample: SystemMetricsSample) => void) => listen('system:metrics', callback),
      getLaunchPrefs: () => ipcRenderer.invoke('system:get-launch-prefs'),
      setLaunchPrefs: (patch) => ipcRenderer.invoke('system:set-launch-prefs', patch),
      getActiveLaunchPrefs: () => ipcRenderer.invoke('system:active-launch-prefs')
    }
  },
  pipe: {
    open: (attempt: string) => ipcRenderer.send('server-pipe:open', attempt),
    send: (text: string) => ipcRenderer.send('server-pipe:send', text),
    close: () => ipcRenderer.send('server-pipe:close'),
    onEvent: (callback: (attempt: string, kind: ServerPipeEventKind, chunk?: string) => void) =>
      listen('server-pipe:event', callback)
  }
}

contextBridge.exposeInMainWorld('electronHost', host)
