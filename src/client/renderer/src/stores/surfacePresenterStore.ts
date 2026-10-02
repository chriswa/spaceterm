import { create } from 'zustand'
import type { NodeId } from '../../../../shared/ids'

/**
 * Who shows a focused terminal: its own card on the canvas, or the host.
 *
 * On the desktop the card does — focusing it swaps the snapshot for a live
 * xterm in place. A phone screen cannot fit a 160-column card on a canvas, so
 * the mobile app sets `external` and shows the focused terminal in a view of
 * its own (the same `TerminalCard`, full screen). App then keeps every canvas
 * card on snapshots, publishes which terminal is focused, and drops focus
 * when the host asks.
 *
 * App owns focus either way; this only decides where the focused terminal is
 * drawn, so navigation, unread handling and the camera stay one code path.
 */
interface SurfacePresenterState {
  external: boolean
  /** The terminal App has focused, or null. Published by App. */
  focusedTerminal: NodeId | null
  /** Bumped by the host to ask App to unfocus. */
  unfocusRequests: number
  /**
   * A surface the host wants focused — the phone's surface list. App navigates
   * to it exactly as for a toolbar crab, so unread clearing and the camera
   * behave the same on both.
   */
  focusRequest: { nodeId: NodeId; seq: number } | null
  setExternal(external: boolean): void
  publishFocusedTerminal(nodeId: NodeId | null): void
  requestUnfocus(): void
  requestFocus(nodeId: NodeId): void
}

export const useSurfacePresenterStore = create<SurfacePresenterState>((set) => ({
  external: false,
  focusedTerminal: null,
  unfocusRequests: 0,
  focusRequest: null,
  setExternal: (external) => set({ external }),
  publishFocusedTerminal: (nodeId) => set((s) => (s.focusedTerminal === nodeId ? s : { focusedTerminal: nodeId })),
  requestUnfocus: () => set((s) => ({ unfocusRequests: s.unfocusRequests + 1 })),
  requestFocus: (nodeId) => set((s) => ({ focusRequest: { nodeId, seq: (s.focusRequest?.seq ?? 0) + 1 } }))
}))
