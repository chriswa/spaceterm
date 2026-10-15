import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import { NotificationSoundToggle } from './buttons'
import { FAKE_DEVICE_ID } from '../../testing/fake-bridge'
import { useNotificationSoundStore, bellRingsNow } from '../../stores/notificationSoundStore'
import { useReceptionistStore } from '../../stores/receptionistStore'

/**
 * The bell sounds only on the device holding Control. Turned on elsewhere it
 * stays on, crossed out and silent, and rings again when Control comes back.
 */
function heldBy(where: 'here' | 'phone' | null): void {
  act(() => useReceptionistStore.getState().setHolder(
    where === null ? null
      : where === 'here' ? { deviceId: FAKE_DEVICE_ID, label: 'Mac' } : { deviceId: 'other', label: 'Phone' },
    FAKE_DEVICE_ID))
}

beforeEach(() => {
  useNotificationSoundStore.setState({ enabled: false })
  useReceptionistStore.setState({ holder: null, mutedHere: false })
})

afterEach(cleanup)

describe('NotificationSoundToggle', () => {
  it('is off, uncrossed and silent until clicked', () => {
    heldBy('here')
    const { container } = render(<NotificationSoundToggle />)
    const button = container.querySelector('button')!
    expect(button.dataset.bell).toBe('off')
    expect(container.querySelector('.control-cross')).toBeNull()
    expect(bellRingsNow()).toBe(false)

    fireEvent.click(button)
    expect(button.dataset.bell).toBe('rings')
    expect(container.querySelector('.control-cross')).toBeNull()
    expect(bellRingsNow()).toBe(true)
  })

  it('stays on but crossed out and silent while Control is elsewhere or unattached', () => {
    act(() => useNotificationSoundStore.setState({ enabled: true }))
    heldBy('phone')
    const { container } = render(<NotificationSoundToggle />)
    const button = container.querySelector('button')!
    expect(button.dataset.bell).toBe('held')
    expect(button.className).toContain('toolbar__btn--active')
    expect(container.querySelector('.control-cross')).not.toBeNull()
    expect(bellRingsNow()).toBe(false)

    heldBy(null)
    expect(button.dataset.bell).toBe('held')
    expect(bellRingsNow()).toBe(false)

    heldBy('here')
    expect(button.dataset.bell).toBe('rings')
    expect(container.querySelector('.control-cross')).toBeNull()
    expect(bellRingsNow()).toBe(true)
  })
})
