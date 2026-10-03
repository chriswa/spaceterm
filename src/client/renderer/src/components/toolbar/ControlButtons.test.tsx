import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import { ControlButton, ControlTalkToMeToggle } from './ControlButtons'
import { installFakeBridge, type FakeBridge } from '../../testing/fake-bridge'
import { useReceptionistStore } from '../../stores/receptionistStore'
import type { ReceptionistStatus } from '../../../../../shared/api'

/**
 * Both controls ask; neither decides. A press goes to the server, and what the
 * buttons show is whatever the server then broadcasts.
 */
let bridge: FakeBridge

function status(s: ReceptionistStatus): void {
  act(() => useReceptionistStore.getState().setStatus(s))
}

beforeEach(() => {
  bridge = installFakeBridge(globalThis as never)
  useReceptionistStore.setState({ phase: 'ready', target: false, error: null, talkToMe: true })
})

afterEach(cleanup)

describe('ControlButton', () => {
  it('sends receptionist-select on every press, whatever it shows', () => {
    const { container } = render(<ControlButton />)
    const button = container.querySelector('button')!
    fireEvent.click(button)
    status({ phase: 'speaking', target: true })
    fireEvent.click(button)
    expect(bridge.callsTo('receptionist.select')).toHaveLength(2)
  })

  it('lights up only while it is the voice target', () => {
    const { container } = render(<ControlButton />)
    const button = container.querySelector('button')!
    expect(button.className).not.toContain('toolbar__btn--active')
    expect(button.getAttribute('aria-pressed')).toBe('false')

    status({ phase: 'ready', target: true })
    expect(button.className).toContain('toolbar__btn--active')
    expect(button.getAttribute('aria-pressed')).toBe('true')
  })

  it('wears the Summary Chat bubble for its phase', () => {
    const { container } = render(<ControlButton />)
    expect(container.querySelector('.toolbar__summary-bubble')).toBeNull()

    status({ phase: 'ready', target: true })
    expect(container.querySelector('.toolbar__summary-bubble--idle')).not.toBeNull()

    status({ phase: 'synthesizing', target: true })
    expect(container.querySelector('.toolbar__summary-bubble--thinking')).not.toBeNull()

    status({ phase: 'speaking', target: true })
    expect(container.querySelector('.toolbar__summary-bubble--talking')).not.toBeNull()
  })

  it('shows it speaking up even when it is not the target', () => {
    const { container } = render(<ControlButton />)
    status({ phase: 'speaking', target: false })
    expect(container.querySelector('.toolbar__summary-bubble--talking')).not.toBeNull()
    expect(container.querySelector('button')!.dataset.tooltip).toMatch(/stop/)
  })

  it('says why it failed', () => {
    const { container } = render(<ControlButton />)
    status({ phase: 'ready', target: false, message: 'no API key' })
    expect(container.querySelector('button')!.dataset.tooltip).toBe('Control — no API key')
  })
})

describe('ControlTalkToMeToggle', () => {
  it('asks the server for the opposite of what it shows', () => {
    const { container } = render(<ControlTalkToMeToggle />)
    fireEvent.click(container.querySelector('button')!)
    expect(bridge.lastCall('receptionist.setTalkToMe')).toEqual([false])
  })

  it('shows the state the server pushed, not the click', () => {
    const { container } = render(<ControlTalkToMeToggle />)
    const button = container.querySelector('button')!
    fireEvent.click(button)
    expect(button.className).toContain('toolbar__btn--active')

    act(() => useReceptionistStore.getState().setTalkToMe(false))
    expect(button.className).not.toContain('toolbar__btn--active')
  })
})
