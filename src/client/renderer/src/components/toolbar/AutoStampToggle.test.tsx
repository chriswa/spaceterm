import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import { AutoStampToggle } from './buttons'
import { installFakeBridge, type FakeBridge } from '../../testing/fake-bridge'
import { useAutoStampsEnabledStore } from '../../stores/autoStampsEnabledStore'

/**
 * The setting is the server's: a click asks for the change, and the button
 * shows whatever the server then broadcasts, to this client and every other.
 */
let bridge: FakeBridge

beforeEach(() => {
  bridge = installFakeBridge(globalThis as never)
  useAutoStampsEnabledStore.setState({ enabled: true })
})

afterEach(cleanup)

describe('AutoStampToggle', () => {
  it('asks the server for the opposite of what it shows', () => {
    const { container } = render(<AutoStampToggle />)
    fireEvent.click(container.querySelector('button')!)
    expect(bridge.lastCall('node.setAutoStampsEnabled')).toEqual([false])
  })

  it('shows the state the server pushed', () => {
    const { container } = render(<AutoStampToggle />)
    const button = container.querySelector('button')!
    expect(button.className).toContain('toolbar__btn--active')

    act(() => useAutoStampsEnabledStore.getState().set(false))
    expect(button.className).not.toContain('toolbar__btn--active')
    expect(button.dataset.tooltip).toMatch(/^Auto Stamp Generation/)
  })
})
