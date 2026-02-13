import { Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'

/**
 * Manages WebGL renderer activation. Only one terminal gets WebGL at a time
 * to avoid hitting the browser's WebGL context limit (8-16).
 */

let activeSessionId: string | null = null
let activeAddon: WebglAddon | null = null

export function activateWebGL(sessionId: string, terminal: Terminal): void {
  if (activeSessionId === sessionId) return

  // Dispose previous WebGL addon
  if (activeAddon) {
    try {
      activeAddon.dispose()
    } catch {
      // Already disposed or context lost
    }
    activeAddon = null
    activeSessionId = null
  }

  try {
    const addon = new WebglAddon()
    addon.onContextLoss(() => {
      try {
        addon.dispose()
      } catch {
        // ignore
      }
      if (activeSessionId === sessionId) {
        activeAddon = null
        activeSessionId = null
      }
    })
    terminal.loadAddon(addon)
    activeAddon = addon
    activeSessionId = sessionId
  } catch {
    // WebGL not available, fall back to DOM renderer (default)
  }
}

export function deactivateWebGL(sessionId: string): void {
  if (activeSessionId !== sessionId) return

  if (activeAddon) {
    try {
      activeAddon.dispose()
    } catch {
      // ignore
    }
    activeAddon = null
    activeSessionId = null
  }
}
