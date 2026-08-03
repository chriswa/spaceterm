import { create } from 'zustand'
import { type NodeId } from '../../../../shared/ids'

/**
 * Resize mode: the modal state behind "Resize terminal".
 *
 * Deliberately shaped like `reparentStore` — enter the mode from the node's
 * action bar, the camera pulls back, the pointer drives a preview, and a click
 * settles it. Nothing is sent to the server until that click: a PTY resize is a
 * SIGWINCH the agent redraws for, so a live drag would be a redraw per frame.
 *
 * `draft` is the size the preview is currently showing, already whole cells and
 * already inside the limits (see `terminalSizeFromCorner`). It is separate from
 * `resizingNodeId` so the pointer can update it many times a second without
 * re-rendering anything that only cares about whether the mode is active.
 */
interface ResizeStoreState {
  resizingNodeId: NodeId | null
  draft: { cols: number; rows: number } | null
  startResize(nodeId: NodeId): void
  setDraft(draft: { cols: number; rows: number }): void
  reset(): void
}

export const useResizeStore = create<ResizeStoreState>((set) => ({
  resizingNodeId: null,
  draft: null,
  startResize: (nodeId) => set({ resizingNodeId: nodeId, draft: null }),
  setDraft: (draft) => set({ draft }),
  reset: () => set({ resizingNodeId: null, draft: null }),
}))
