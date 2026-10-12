import { describe, it, expect } from 'vitest'
import { receivesSnapshots, owedOnResume, type SnapshotSubscriber } from './snapshot-delivery'
import { asPtySessionId } from '../shared/ids'

const a = asPtySessionId('a')
const b = asPtySessionId('b')

function client(canvasPaused?: boolean): SnapshotSubscriber {
  return { subscriptions: new Map([[a, 'snapshot'], [b, 'live']]), canvasPaused }
}

describe('receivesSnapshots', () => {
  it('sends a subscribed session to a client whose canvas is showing', () => {
    expect(receivesSnapshots(client(), a)).toBe(true)
    expect(receivesSnapshots(client(false), a)).toBe(true)
  })

  it('sends nothing to a paused canvas', () => {
    expect(receivesSnapshots(client(true), a)).toBe(false)
  })

  it('never sends snapshots for a live or unsubscribed session', () => {
    expect(receivesSnapshots(client(), b)).toBe(false)
    expect(receivesSnapshots(client(), asPtySessionId('c'))).toBe(false)
  })
})

describe('owedOnResume', () => {
  it('is every snapshot subscription, and nothing live', () => {
    expect(owedOnResume(client(true))).toEqual([a])
  })
})
