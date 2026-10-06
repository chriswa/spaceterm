import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileEventRecord } from '../shared/protocol'

/**
 * The app forgets an event only when the server has it: this page takes it,
 * the server acknowledges the batch, and the page tells the app.
 */
async function setup() {
  vi.resetModules()
  localStorage.clear()
  const posted: unknown[] = []
  window.webkit = { messageHandlers: { nativeEvents: { postMessage: (m: unknown) => posted.push(m) } } }
  const { installNativeEventBridge } = await import('./lifecycle-events')
  const { mobileEvents } = await import('./mobile-events')
  installNativeEventBridge()
  const batches: { events: MobileEventRecord[]; ack: () => void }[] = []
  mobileEvents.setSender((events) => new Promise<void>((resolve) => { batches.push({ events, ack: resolve }) }))
  return { posted, batches, push: (seqs: number[]) => window.spacetermNativeEvents!.push(seqs.map((seq) => ({ seq, t: '2026-10-05T12:00:00Z', kind: 'app-background' }))) }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** The server acknowledging every batch, including those sent once the last is acknowledged. */
async function ackAll(batches: { ack: () => void }[]) {
  for (let i = 0; i < batches.length; i++) {
    batches[i].ack()
    await settle()
  }
}

beforeEach(() => { delete window.webkit })

describe('the app’s events', () => {
  it('are acknowledged to the app only once the server has them', async () => {
    const { posted, batches, push } = await setup()
    expect(push([1, 2])).toBe(true)
    expect(posted).toEqual([])
    await ackAll(batches)
    expect(batches.flatMap((b) => b.events.map((e) => e.nativeSeq))).toEqual([1, 2])
    expect(posted.at(-1)).toEqual({ action: 'ack', through: 2 })
  })

  it('handed over again to a new page, are not recorded twice, and what the server has is acknowledged again', async () => {
    const first = await setup()
    first.push([1, 2])
    await ackAll(first.batches)
    first.push([3])

    // The page reloads before 3 is acknowledged; the app hands over all it holds.
    const { mobileEvents } = await import('./mobile-events')
    const pendingBefore = mobileEvents.pending
    first.posted.length = 0
    first.push([1, 2, 3])
    expect(mobileEvents.pending).toBe(pendingBefore)
    expect(first.posted).toEqual([{ action: 'ack', through: 2 }])
  })
})
