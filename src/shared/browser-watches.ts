import type { NodeId } from './ids'
import type { BrowserFrameMessage } from './protocol'
import type { BrowserViewport } from './browser'

export interface BrowserWatchOptions {
  live: boolean
  scale: number
  viewport?: BrowserViewport
}

/** One view's interest in a card's page. */
export interface BrowserWatch {
  update(opts: BrowserWatchOptions): void
  release(): void
}

/** Resolves once the frame is on screen, which is when the next may be sent. */
export type BrowserFrameListener = (frame: BrowserFrameMessage) => Promise<void> | void

interface Transport {
  watch(nodeId: NodeId, opts: BrowserWatchOptions): void
  unwatch(nodeId: NodeId): void
  ack(nodeId: NodeId): void
}

interface Entry {
  opts: BrowserWatchOptions
  onFrame: BrowserFrameListener
  /** Order of the last update, so the newest borrower's viewport wins. */
  order: number
}

/**
 * Every view of a card's page in this client, as the one watch the server
 * keeps per client and card.
 *
 * The phone shows a card twice at once — its thumbnail on the canvas and the
 * page full screen over it — and the server cannot tell the two apart. So the
 * views are merged here: live if any is, at the sharpest scale any asks for,
 * at the viewport the most recent borrower set. A frame goes to every view and
 * is acknowledged once all of them have drawn it.
 */
export class BrowserWatches {
  private readonly views = new Map<NodeId, Set<Entry>>()
  private readonly sent = new Map<NodeId, string>()
  private order = 0

  constructor(private readonly transport: Transport) {}

  watch(nodeId: NodeId, opts: BrowserWatchOptions, onFrame: BrowserFrameListener): BrowserWatch {
    const entry: Entry = { opts, onFrame, order: ++this.order }
    let set = this.views.get(nodeId)
    if (!set) {
      set = new Set()
      this.views.set(nodeId, set)
    }
    set.add(entry)
    this.sync(nodeId)
    return {
      update: (next) => {
        if (!set.has(entry)) return
        entry.opts = next
        entry.order = ++this.order
        this.sync(nodeId)
      },
      release: () => {
        if (!set.delete(entry)) return
        if (set.size === 0) this.views.delete(nodeId)
        this.sync(nodeId)
      }
    }
  }

  /** A frame from the server: to every view of the card, then acknowledged. */
  deliver(frame: BrowserFrameMessage): void {
    const set = this.views.get(frame.nodeId)
    if (!set) return
    const drawn = [...set].map((entry) => Promise.resolve().then(() => entry.onFrame(frame)).catch(() => undefined))
    void Promise.all(drawn).then(() => {
      if (this.views.has(frame.nodeId)) this.transport.ack(frame.nodeId)
    })
  }

  private sync(nodeId: NodeId): void {
    const set = this.views.get(nodeId)
    if (!set || set.size === 0) {
      if (this.sent.delete(nodeId)) this.transport.unwatch(nodeId)
      return
    }
    const merged = merge([...set])
    const key = JSON.stringify(merged)
    if (this.sent.get(nodeId) === key) return
    this.sent.set(nodeId, key)
    this.transport.watch(nodeId, merged)
  }
}

function merge(entries: Entry[]): BrowserWatchOptions {
  let live = false
  let scale = 0
  let borrower: Entry | undefined
  for (const entry of entries) {
    live ||= entry.opts.live
    scale = Math.max(scale, entry.opts.scale)
    if (entry.opts.viewport && (!borrower || entry.order > borrower.order)) borrower = entry
  }
  return { live, scale, ...(borrower?.opts.viewport ? { viewport: borrower.opts.viewport } : {}) }
}
