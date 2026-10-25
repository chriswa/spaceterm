import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installFakeBridge, type FakeBridge } from '../testing/fake-bridge'
import { recordMobileEvent } from '../../../../mobile/mobile-events'
import { setHandsFree, useHandsFree } from '../../../../mobile/hands-free'
import { handsFreeBlocker, installDesktopHandsFree } from './desktop-hands-free'

function fakeClient() {
  return {
    mobileEvents: vi.fn(async (_events: Array<{ kind: string }>) => undefined),
    onLifecycle: vi.fn(() => () => undefined),
  }
}

let uninstall: () => void
let client: ReturnType<typeof fakeClient>
let bridge: FakeBridge

beforeEach(() => {
  bridge = installFakeBridge()
  client = fakeClient()
  uninstall = installDesktopHandsFree(client)
})

afterEach(() => {
  uninstall()
})

describe('hands-free on the Mac', () => {
  it('is Voice Operator on the Mac\'s microphone, switched through the server', () => {
    expect(useHandsFree.getState().phase).toBe('off')
    setHandsFree(true)
    setHandsFree(false)
    expect(bridge.calls.filter((c) => c.method === 'handsFree.setMac').map((c) => c.args)).toEqual([[true], [false]])
  })

  it('follows what Voice Operator says about the Mac', () => {
    setHandsFree(true)
    bridge.emit.handsFreeMacEvent({ type: 'state', phase: 'listening', conversation: true, closesAt: null, checking: false, pending: false })
    expect(useHandsFree.getState()).toMatchObject({ on: true, phase: 'listening', conversation: true })
    bridge.emit.handsFreeMacEvent({ type: 'transcript', text: 'Control, run the tests.', trigger: 'control', interrupted: false, reason: 'finished', shutdown: false })
    expect(bridge.calls.filter((c) => c.method === 'handsFree.say').map((c) => c.args)).toEqual([['run the tests.', false]])
  })

  it('sends its audio and lifecycle record to the server, as the phone does', () => {
    recordMobileEvent('test-event', { from: 'mac' })
    const sent = client.mobileEvents.mock.calls.flatMap(([events]) => events)
    expect(sent.map((e) => e.kind)).toContain('test-event')
  })
})

describe('whether hands-free can run on this Mac', () => {
  it('needs macOS 26, for Voice Operator\'s wake-word check', () => {
    expect(handsFreeBlocker('26.0')).toBeNull()
    expect(handsFreeBlocker('27.1.2')).toBeNull()
    expect(handsFreeBlocker('15.8.1')).toMatch(/needs macOS 26.*macOS 15\.8\.1/)
    expect(handsFreeBlocker(null)).toMatch(/needs macOS 26/)
  })
})
