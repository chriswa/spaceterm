import { describe, expect, it } from 'vitest'
import { BrowserWatches, type BrowserWatchOptions } from './browser-watches'
import { asNodeId, type NodeId } from './ids'
import type { BrowserFrameMessage } from './protocol'

const CARD = asNodeId('card')

function harness() {
  const sent: Array<['watch', NodeId, BrowserWatchOptions] | ['unwatch', NodeId] | ['ack', NodeId]> = []
  const watches = new BrowserWatches({
    watch: (nodeId, opts) => sent.push(['watch', nodeId, opts]),
    unwatch: (nodeId) => sent.push(['unwatch', nodeId]),
    ack: (nodeId) => sent.push(['ack', nodeId])
  })
  return { watches, sent }
}

const frame: BrowserFrameMessage = { type: 'browser-frame', nodeId: CARD, data: 'jpeg', width: 1280, height: 800 }
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('BrowserWatches', () => {
  it("merges a client's views of one card into one watch: live if any is, sharpest scale, newest borrower's viewport", () => {
    const { watches, sent } = harness()
    const thumbnail = watches.watch(CARD, { live: false, scale: 0.5 }, () => undefined)
    watches.watch(CARD, { live: true, scale: 3, viewport: { width: 390, height: 700, mobile: true } }, () => undefined)
    expect(sent).toEqual([
      ['watch', CARD, { live: false, scale: 0.5 }],
      ['watch', CARD, { live: true, scale: 3, viewport: { width: 390, height: 700, mobile: true } }]
    ])
    // Changing the thumbnail to what the merge already says sends nothing.
    thumbnail.update({ live: false, scale: 1 })
    expect(sent).toHaveLength(2)
  })

  it('stops watching only when the last view goes', () => {
    const { watches, sent } = harness()
    const a = watches.watch(CARD, { live: false, scale: 1 }, () => undefined)
    const b = watches.watch(CARD, { live: true, scale: 2 }, () => undefined)
    b.release()
    expect(sent.at(-1)).toEqual(['watch', CARD, { live: false, scale: 1 }])
    a.release()
    a.release()
    expect(sent.at(-1)).toEqual(['unwatch', CARD])
    expect(sent.filter(([kind]) => kind === 'unwatch')).toHaveLength(1)
  })

  it('acknowledges a frame once, after every view has drawn it', async () => {
    const { watches, sent } = harness()
    let finishDrawing!: () => void
    watches.watch(CARD, { live: false, scale: 1 }, () => undefined)
    watches.watch(CARD, { live: true, scale: 2 }, () => new Promise<void>((resolve) => { finishDrawing = resolve }))
    watches.deliver(frame)
    await flush()
    expect(sent.filter(([kind]) => kind === 'ack')).toEqual([])
    finishDrawing()
    await flush()
    expect(sent.filter(([kind]) => kind === 'ack')).toEqual([['ack', CARD]])
  })

  it('acknowledges even when a view fails to draw, so the page is not stalled', async () => {
    const { watches, sent } = harness()
    watches.watch(CARD, { live: true, scale: 1 }, () => Promise.reject(new Error('bad jpeg')))
    watches.deliver(frame)
    await flush()
    expect(sent.at(-1)).toEqual(['ack', CARD])
  })
})
