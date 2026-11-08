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
 *   page → app:  `{kind: 'ready'}`, `{kind: 'show', id, title, body}`, `{kind: 'clear', id}`
 *   app → page:  `window.spacetermNativeNotifications.tapped(id)`
 */

interface NotificationHandler {
  postMessage(message: unknown): void
}

declare global {
  interface Window {
    spacetermNativeNotifications?: { tapped(id: string): void }
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
export function installBlockAlerts(client: Pick<ServerClient, 'on'>): void {
  const app = handler()
  if (!app) return
  client.on('block-alert', ({ nodeId, title, body }) => {
    const shown = !lookingAt(nodeId)
    recordMobileEvent('block-alert', { nodeId, shown })
    if (shown) app.postMessage({ kind: 'show', id: nodeId, title, body })
  })
  client.on('block-alert-cleared', ({ nodeId }) => app.postMessage({ kind: 'clear', id: nodeId }))
  window.spacetermNativeNotifications = { tapped: (id) => openAgent(asNodeId(id)) }
  // Last: this asks for permission, and hands over a tap that launched the app.
  app.postMessage({ kind: 'ready' })
}
