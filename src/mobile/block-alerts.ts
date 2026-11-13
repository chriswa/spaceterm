import { asNodeId, type NodeId } from '../shared/ids'
import type { ServerClient } from '../shared/server-client'
import { showAgent } from '@/components/ControlTranscript'
import { useControlTranscriptStore } from '@/stores/controlTranscriptStore'
import { useNodeStore } from '@/stores/nodeStore'
import { useSurfacePresenterStore } from '@/stores/surfacePresenterStore'
import { recordMobileEvent } from './mobile-events'

/**
 * Notifications of agents blocked on the user, raised by the iPhone app
 * (`NativeNotifications.swift`) because a page cannot raise one. The server
 * decides when (`src/server/block-alerts.ts`); this only passes it on.
 *
 * Normally the notification comes through Apple (`src/server/apns.ts`) and the
 * page's part is only to hand the server the app's push token and say what is
 * on screen. A `block-alert` over the socket means Apple could not be used.
 *
 *   page → app:  `{kind: 'ready'}`, `{kind: 'show', id, title, subtitle?, body, always?}`, `{kind: 'clear', id}`
 *
 * `always` (an agent's own `notify_user`) is shown even on that agent's
 * terminal; a prompt is not, as it is already on screen there.
 *   app → page:  `window.spacetermNativeNotifications.tapped(id)`, `.lookingAt(id)`, `.pushToken(token)`
 */

interface NotificationHandler {
  postMessage(message: unknown): void
}

declare global {
  interface Window {
    spacetermNativeNotifications?: { tapped(id: string): void; lookingAt(id: string): boolean; pushToken(token: string): void }
  }
}

function handler(): NotificationHandler | undefined {
  return window.webkit?.messageHandlers?.nativeNotifications as NotificationHandler | undefined
}

/** Whether the user is already looking at this terminal, where the prompt is on screen. */
function lookingAt(nodeId: NodeId): boolean {
  return document.visibilityState === 'visible' && useSurfacePresenterStore.getState().focusedTerminal === nodeId
}

/** Go to a blocked agent. After a cold launch the tap can arrive before the nodes have. */
function openAgent(nodeId: NodeId): void {
  const go = () => showAgent(nodeId, () => {
    useControlTranscriptStore.getState().setOpen(false)
    useSurfacePresenterStore.getState().setToolbarSheetOpen(false)
  })
  if (Object.keys(useNodeStore.getState().nodes).length > 0) return go()
  const unsubscribe = useNodeStore.subscribe((state) => {
    if (Object.keys(state.nodes).length === 0) return
    unsubscribe()
    go()
  })
}

/** In a browser, or an app built before this existed, there is nothing to raise one. */
export function installBlockAlerts(client: Pick<ServerClient, 'on' | 'onLifecycle' | 'registerPushToken'>, deviceId: string): void {
  const app = handler()
  if (!app) return
  client.on('block-alert', ({ nodeId, title, body, always, source }) => {
    const shown = always === true || !lookingAt(nodeId)
    recordMobileEvent('block-alert', { nodeId, shown, ...(always ? { always } : {}) })
    if (shown) app.postMessage({ kind: 'show', id: nodeId, title, ...(source ? { subtitle: source } : {}), body, ...(always ? { always } : {}) })
  })
  client.on('block-alert-cleared', ({ nodeId }) => app.postMessage({ kind: 'clear', id: nodeId }))
  let token: string | undefined
  const register = () => { if (token) client.registerPushToken(deviceId, token) }
  client.onLifecycle('connect', register)
  window.spacetermNativeNotifications = {
    tapped: (id) => openAgent(asNodeId(id)),
    lookingAt: (id) => lookingAt(asNodeId(id)),
    pushToken: (received) => {
      token = received
      register()
    },
  }
  // Last: this asks for permission, and hands over a tap that launched the app.
  app.postMessage({ kind: 'ready' })
}
