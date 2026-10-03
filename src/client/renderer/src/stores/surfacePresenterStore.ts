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
   * How far the latest unfocus request pulls the camera back, at least (see
   * flyToUnfocusZoom); App's default when unset. The phone leaves further out
   * after a sideways swipe than after a pinch.
   */
  unfocusZoomOut: number | undefined
  /**
   * A surface the host wants focused — the phone's surface list. App navigates
   * to it exactly as for a toolbar crab, so unread clearing and the camera
   * behave the same on both.
   */
  focusRequest: { nodeId: NodeId; seq: number } | null
  /**
   * The toolbar as a sheet opened on demand (the phone), instead of a bar
   * along the bottom. App renders it either way; this only says how.
   */
  toolbarSheet: boolean
  toolbarSheetOpen: boolean
  setToolbarSheet(sheet: boolean): void
  setToolbarSheetOpen(open: boolean): void
  setExternal(external: boolean): void
  publishFocusedTerminal(nodeId: NodeId | null): void
  requestUnfocus(zoomOut?: number): void
  requestFocus(nodeId: NodeId): void
}

export const useSurfacePresenterStore = create<SurfacePresenterState>((set) => ({
  external: false,
  focusedTerminal: null,
  unfocusRequests: 0,
  unfocusZoomOut: undefined,
  focusRequest: null,
  toolbarSheet: false,
  toolbarSheetOpen: false,
  setToolbarSheet: (toolbarSheet) => set({ toolbarSheet }),
  setToolbarSheetOpen: (toolbarSheetOpen) => set({ toolbarSheetOpen }),
  setExternal: (external) => set({ external }),
  publishFocusedTerminal: (nodeId) => set((s) => (s.focusedTerminal === nodeId ? s : { focusedTerminal: nodeId })),
  requestUnfocus: (zoomOut) => set((s) => ({ unfocusRequests: s.unfocusRequests + 1, unfocusZoomOut: zoomOut })),
  requestFocus: (nodeId) => set((s) => ({ focusRequest: { nodeId, seq: (s.focusRequest?.seq ?? 0) + 1 } }))
}))
