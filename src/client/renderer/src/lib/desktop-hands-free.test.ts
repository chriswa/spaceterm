import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installFakeBridge } from '../testing/fake-bridge'
import { holdHost, setHoldMicrophone } from '../../../../mobile/held-microphone'
import { recordMobileEvent } from '../../../../mobile/mobile-events'
import { useHandsFree } from '../../../../mobile/hands-free'
import { installDesktopHandsFree } from './desktop-hands-free'

function fakeClient() {
  return {
    mobileEvents: vi.fn(async (_events: Array<{ kind: string }>) => undefined),
    onLifecycle: vi.fn(() => () => undefined),
  }
}

let uninstall: () => void
let client: ReturnType<typeof fakeClient>
const host = { microphoneHeld: vi.fn() }

beforeEach(() => {
  installFakeBridge()
  client = fakeClient()
  host.microphoneHeld.mockClear()
  uninstall = installDesktopHandsFree(client, host)
})

afterEach(() => {
  setHoldMicrophone(false)
  uninstall()
})

describe('hands-free on the Mac', () => {
  it('runs the phone\'s hands-free mode with the Mac as the hold\'s host', () => {
    expect(holdHost()).toBe('desktop')
    // Not listening until it is switched on.
    expect(useHandsFree.getState().phase).toBe('off')
  })

  it('keeps the window unthrottled for exactly as long as hands-free is on', () => {
    setHoldMicrophone(true)
    expect(host.microphoneHeld).toHaveBeenLastCalledWith(true)
    setHoldMicrophone(false)
    expect(host.microphoneHeld).toHaveBeenLastCalledWith(false)
  })

  it('sends its audio and lifecycle record to the server, as the phone does', () => {
    recordMobileEvent('test-event', { from: 'mac' })
    const sent = client.mobileEvents.mock.calls.flatMap(([events]) => events)
    expect(sent.map((e) => e.kind)).toContain('test-event')
  })

  it('stops following the hold once uninstalled', () => {
    uninstall()
    setHoldMicrophone(true)
    expect(host.microphoneHeld).not.toHaveBeenCalled()
    uninstall = () => undefined
  })
})
