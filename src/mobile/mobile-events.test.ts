import { describe, expect, it } from 'vitest'
import type { MobileEventRecord } from '../shared/protocol'
import { MobileEvents, type MobileEventsDeps } from './mobile-events'

function setup(saved: string | null = null, page = 'p1') {
  const store = { json: saved }
  const deps: MobileEventsDeps = {
    load: () => store.json,
    save: (json) => { store.json = json },
    now: () => new Date('2026-10-05T12:00:00Z'),
    page,
  }
  return { events: new MobileEvents(deps), store }
}

/** A sender whose batches the test answers. */
function server() {
  const batches: { events: MobileEventRecord[]; ack: () => void; fail: () => void }[] = []
  const send = (events: MobileEventRecord[]) => new Promise<void>((resolve, reject) => {
    batches.push({ events, ack: resolve, fail: () => reject(new Error('Disconnected from server')) })
  })
  return { batches, send }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('MobileEvents', () => {
  it('numbers each event and says what the page was doing at the time', () => {
    const { events, store } = setup()
    let held = 'off'
    events.addContext('hold', () => held)
    events.record('hold-wanted', { on: true })
    held = 'held'
    events.record('hold-state')
    const saved = JSON.parse(store.json!) as MobileEventRecord[]
    expect(saved).toEqual([
      expect.objectContaining({ n: 0, kind: 'hold-wanted', src: 'page', detail: { on: true }, ctx: { hold: 'off' }, page: 'p1' }),
      expect.objectContaining({ n: 1, kind: 'hold-state', ctx: { hold: 'held' } }),
    ])
  })

  it('keeps events until the server acknowledges them, and resends after a failure', async () => {
    const { events } = setup()
    const { batches, send } = server()
    events.record('visibility', { state: 'hidden' })
    events.setSender(send)
    expect(batches).toHaveLength(1)
    batches[0].fail()
    await settle()
    expect(events.pending).toBe(1)

    events.record('visibility', { state: 'visible' })
    expect(batches).toHaveLength(2)
    expect(batches[1].events.map((e) => e.n)).toEqual([0, 1])
    // Recorded mid-send: kept for the next batch.
    events.record('mic-opened')
    batches[1].ack()
    await settle()
    expect(batches).toHaveLength(3)
    expect(batches[2].events.map((e) => e.kind)).toEqual(['mic-opened'])
    batches[2].ack()
    await settle()
    expect(events.pending).toBe(0)
  })

  it('sends what an earlier page load left unsent', () => {
    const first = setup(null, 'old')
    first.events.record('woke')
    const { events } = setup(first.store.json, 'new')
    const { batches, send } = server()
    events.record('page-load')
    events.setSender(send)
    expect(batches[0].events.map((e) => `${e.page}:${e.kind}`)).toEqual(['old:woke', 'new:page-load'])
  })

  it('keeps the time and source of what the app saw', () => {
    const { events, store } = setup()
    events.record('app-background', undefined, { src: 'native', t: '2026-10-05T11:00:00Z' })
    expect(JSON.parse(store.json!)[0]).toMatchObject({ src: 'native', t: '2026-10-05T11:00:00Z' })
  })
})
