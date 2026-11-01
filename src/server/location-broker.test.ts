import { describe, expect, it } from 'vitest'
import { LocationBroker, type LocationCandidate } from './location-broker'
import type { LocationFix } from '../shared/location'

const fix = (latitude: number): LocationFix => ({ latitude, longitude: -123, accuracyMeters: 10, timestamp: 1 })

function harness(candidates: LocationCandidate[]) {
  const asked: Array<{ clientId: string; requestId: string }> = []
  let fireDeadline: (() => void) | undefined
  let cancelled = false
  const broker = new LocationBroker({
    candidates: () => candidates,
    ask: (clientId, requestId) => asked.push({ clientId, requestId }),
    schedule: (_ms, fn) => {
      fireDeadline = fn
      return () => { cancelled = true }
    },
  })
  const settled: { value?: unknown; error?: Error } = {}
  const locate = () => broker.locate().then((v) => { settled.value = v }, (e: Error) => { settled.error = e })
  return { broker, asked, settled, locate, deadline: () => fireDeadline?.(), wasCancelled: () => cancelled }
}

const phone = { clientId: 'p', device: 'iPhone' }
const mac = { clientId: 'm', device: 'Mac' }

describe('LocationBroker', () => {
  it('asks every candidate and takes the best-ranked fix', async () => {
    const h = harness([phone, mac])
    const done = h.locate()
    expect(h.asked.map((a) => a.clientId)).toEqual(['p', 'm'])
    const id = h.asked[0].requestId
    h.broker.answer('p', id, { ok: true, fix: fix(49) })
    await done
    expect(h.settled.value).toEqual({ device: 'iPhone', fix: fix(49) })
    expect(h.wasCancelled()).toBe(true)
  })

  it('waits for a better-ranked device still thinking rather than taking a worse one', async () => {
    const h = harness([phone, mac])
    const done = h.locate()
    const id = h.asked[0].requestId
    h.broker.answer('m', id, { ok: true, fix: fix(1) })
    await Promise.resolve()
    expect(h.settled).toEqual({})
    h.broker.answer('p', id, { ok: true, fix: fix(2) })
    await done
    expect(h.settled.value).toMatchObject({ device: 'iPhone' })
  })

  it('falls through to the next device when the preferred one fails or goes away', async () => {
    const h = harness([phone, mac])
    const done = h.locate()
    const id = h.asked[0].requestId
    h.broker.answer('m', id, { ok: true, fix: fix(1) })
    h.broker.disconnected('p')
    await done
    expect(h.settled.value).toMatchObject({ device: 'Mac' })
  })

  it('at the deadline keeps the best fix in, and otherwise says why each device had none', async () => {
    const a = harness([phone, mac])
    const doneA = a.locate()
    a.broker.answer('m', a.asked[0].requestId, { ok: true, fix: fix(1) })
    a.deadline()
    await doneA
    expect(a.settled.value).toMatchObject({ device: 'Mac' })

    const b = harness([phone, mac])
    const doneB = b.locate()
    b.broker.answer('m', b.asked[0].requestId, { ok: false, error: 'location permission was denied on this device' })
    b.deadline()
    await doneB
    expect(b.settled.error?.message).toContain('iPhone: no answer in time')
    expect(b.settled.error?.message).toContain('Mac: location permission was denied')
  })

  it('fails at once with nobody to ask', async () => {
    const h = harness([])
    await h.locate()
    expect(h.settled.error?.message).toMatch(/No Spaceterm client is connected/)
    expect(h.asked).toEqual([])
  })

  it('ignores answers to a settled request and from clients it never asked', async () => {
    const h = harness([phone])
    const done = h.locate()
    const id = h.asked[0].requestId
    h.broker.answer('stranger', id, { ok: true, fix: fix(5) })
    h.broker.answer('p', id, { ok: false, error: 'no' })
    await done
    expect(() => h.broker.answer('p', id, { ok: true, fix: fix(3) })).not.toThrow()
    expect(h.settled.error?.message).toContain('iPhone: no')
  })
})
