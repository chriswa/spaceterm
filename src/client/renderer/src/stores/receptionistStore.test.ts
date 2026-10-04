import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { FAKE_DEVICE_ID, installFakeBridge, type FakeBridge } from '../testing/fake-bridge'
import { initServerSync, destroyServerSync } from '../lib/server-sync'
import { useReceptionistStore } from './receptionistStore'
import { useAgentNamesStore } from './agentNamesStore'

/**
 * The receptionist's state is the server's: these stores only mirror what the
 * bridge pushes. Driven through `initServerSync`, so the wiring is under test
 * as well as the stores.
 */

let bridge: FakeBridge

beforeEach(() => {
  bridge = installFakeBridge(globalThis as never)
  useReceptionistStore.setState({ phase: 'ready', target: false, error: null, holder: null })
  useAgentNamesStore.setState({ names: {} })
})

afterEach(() => destroyServerSync())

describe('receptionist status', () => {
  it('follows the server: target, phase, and an error that clears', async () => {
    await initServerSync()
    bridge.emit.receptionistStatus({ phase: 'ready', target: true })
    expect(useReceptionistStore.getState()).toMatchObject({ target: true, phase: 'ready', error: null })

    bridge.emit.receptionistStatus({ phase: 'speaking', target: true })
    expect(useReceptionistStore.getState().phase).toBe('speaking')

    bridge.emit.receptionistStatus({ phase: 'ready', target: false, message: 'no model' })
    expect(useReceptionistStore.getState()).toMatchObject({ target: false, error: 'no model' })

    bridge.emit.receptionistStatus({ phase: 'ready', target: false })
    expect(useReceptionistStore.getState().error).toBeNull()
  })

  it('takes the holder from the pull, and from the push after it, telling this device apart', async () => {
    bridge.responses.syncRequest = { ...bridge.responses.syncRequest, receptionistHolder: { deviceId: 'phone-1', label: 'Phone' } }
    await initServerSync()
    expect(useReceptionistStore.getState().holder).toEqual({ label: 'Phone', mine: false })

    bridge.emit.receptionistHolder({ deviceId: FAKE_DEVICE_ID, label: 'Mac' })
    expect(useReceptionistStore.getState().holder).toEqual({ label: 'Mac', mine: true })

    bridge.emit.receptionistHolder(null)
    expect(useReceptionistStore.getState().holder).toBeNull()
  })

  it('reads an absent holder in the pull as the Mac', async () => {
    await initServerSync()
    expect(useReceptionistStore.getState().holder).toEqual({ label: 'Mac', mine: false })
  })
})

describe('agent names', () => {
  it('replaces the whole map on each push, so a released name goes', async () => {
    await initServerSync()
    bridge.emit.agentNames({ a: 'Kevin', b: 'Maria' })
    expect(useAgentNamesStore.getState().names).toEqual({ a: 'Kevin', b: 'Maria' })

    bridge.emit.agentNames({ b: 'Maria' })
    expect(useAgentNamesStore.getState().names).toEqual({ b: 'Maria' })
  })

  it('stops listening on teardown', async () => {
    await initServerSync()
    destroyServerSync()
    bridge.emit.agentNames({ a: 'Kevin' })
    expect(useAgentNamesStore.getState().names).toEqual({})
  })
})
