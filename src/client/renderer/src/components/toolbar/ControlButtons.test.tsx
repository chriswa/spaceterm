import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import { ControlButton, ControlTranscriptButton } from './ControlButtons'
import { Toolbar } from '../Toolbar'
import { FAKE_DEVICE_ID, installFakeBridge, type FakeBridge } from '../../testing/fake-bridge'
import { useReceptionistStore } from '../../stores/receptionistStore'
import { useControlTranscriptStore } from '../../stores/controlTranscriptStore'
import { LONG_PRESS_MS } from '../../hooks/useLongPress'
import type { ReceptionistStatus } from '../../../../../shared/api'

/**
 * The button asks; it never decides. A press goes to the server, and what the
 * buttons show is whatever the server then broadcasts.
 */
let bridge: FakeBridge

function status(s: ReceptionistStatus): void {
  act(() => useReceptionistStore.getState().setStatus(s))
}

/** Control on this device, or on `label`'s. */
function heldBy(label: 'here' | string): void {
  act(() => useReceptionistStore.getState().setHolder(
    label === 'here' ? { deviceId: FAKE_DEVICE_ID, label: 'Mac' } : { deviceId: 'other', label }, FAKE_DEVICE_ID))
}

beforeEach(() => {
  bridge = installFakeBridge(globalThis as never)
  useReceptionistStore.setState({ phase: 'ready', target: false, error: null, holder: null })
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

  it('opens the transcript on a long press, without selecting', () => {
    vi.useFakeTimers()
    try {
      useControlTranscriptStore.setState({ open: false })
      const { container } = render(<ControlButton />)
      const button = container.querySelector('button')!
      fireEvent.pointerDown(button, { button: 0 })
      act(() => { vi.advanceTimersByTime(LONG_PRESS_MS) })
      fireEvent.pointerUp(button)
      fireEvent.click(button)
      expect(useControlTranscriptStore.getState().open).toBe(true)
      expect(bridge.callsTo('receptionist.select')).toHaveLength(0)

      // While it is open, a click closes it rather than selecting.
      fireEvent.click(button)
      expect(useControlTranscriptStore.getState().open).toBe(false)
      expect(bridge.callsTo('receptionist.select')).toHaveLength(0)

      // Then a short press is an ordinary tap again.
      fireEvent.pointerDown(button, { button: 0 })
      fireEvent.pointerUp(button)
      fireEvent.click(button)
      expect(bridge.callsTo('receptionist.select')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is black elsewhere, white here and talked to, magenta here with the voice on Summary Chat', () => {
    const { container } = render(<ControlButton />)
    const button = container.querySelector('button')!
    heldBy('Phone')
    status({ phase: 'ready', target: true })
    expect(button.className).toContain('toolbar__control--away')
    expect(button.dataset.tooltip).toMatch(/On your Phone\. Click to bring it here/)

    heldBy('here')
    expect(button.className).toContain('toolbar__control--here')
    expect(button.className).toContain('toolbar__btn--active')
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.dataset.tooltip).toMatch(/let go/)

    status({ phase: 'ready', target: false })
    expect(button.className).toContain('toolbar__control--summary')
    expect(button.dataset.tooltip).toMatch(/Summary Chat\. Click to talk to Control/)
  })

  it('wears the Summary Chat bubble for its phase while it is here', () => {
    heldBy('here')
    const { container } = render(<ControlButton />)
    expect(container.querySelector('.toolbar__summary-bubble')).toBeNull()

    status({ phase: 'ready', target: true })
    expect(container.querySelector('.toolbar__summary-bubble--idle')).not.toBeNull()

    status({ phase: 'synthesizing', target: true })
    expect(container.querySelector('.toolbar__summary-bubble--thinking')).not.toBeNull()

    status({ phase: 'speaking', target: true })
    expect(container.querySelector('.toolbar__summary-bubble--talking')).not.toBeNull()
  })

  it('shows it speaking up even when the voice is on Summary Chat, and not when it is elsewhere', () => {
    heldBy('here')
    const { container } = render(<ControlButton />)
    status({ phase: 'speaking', target: false })
    expect(container.querySelector('.toolbar__summary-bubble--talking')).not.toBeNull()

    status({ phase: 'speaking', target: true })
    expect(container.querySelector('button')!.dataset.tooltip).toMatch(/stop it and let go/)

    heldBy('Phone')
    expect(container.querySelector('.toolbar__summary-bubble')).toBeNull()
  })

  it('says why it failed', () => {
    const { container } = render(<ControlButton />)
    status({ phase: 'ready', target: false, message: 'no API key' })
    expect(container.querySelector('button')!.dataset.tooltip).toMatch(/^Control — no API key\./)
  })
})

describe('ControlTranscriptButton', () => {
  it('shows the transcript on a click and hides it on the next', () => {
    act(() => useControlTranscriptStore.getState().setOpen(false))
    const { container } = render(<ControlTranscriptButton />)
    const button = container.querySelector('button')!
    fireEvent.click(button)
    expect(useControlTranscriptStore.getState().open).toBe(true)
    expect(button.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(button)
    expect(useControlTranscriptStore.getState().open).toBe(false)
  })
})

describe('the phone toolbar sheet', () => {
  it('leaves out Control and its transcript button, which the bottom bar covers', () => {
    const host = {
      onHelpClick: () => {}, keycastEnabled: false, onKeycastToggle: () => {}, onDebugCapture: () => {},
      onInertiaLogDump: () => {}, restartingSpaceterm: false, onRestartSpaceterm: () => {}, crabs: [],
      onCrabClick: () => {}, onCrabReorder: () => {}, selectedNodeId: null, crabNavEvent: null, now: 0, onStepOut: () => {}
    }
    const bar = render(<Toolbar {...host} />)
    expect(bar.queryByRole('button', { name: 'Control' })).not.toBeNull()
    expect(bar.queryByRole('button', { name: 'Control transcript' })).not.toBeNull()
    bar.unmount()

    const sheet = render(<Toolbar {...host} variant="sheet" />)
    expect(sheet.queryByRole('button', { name: 'Control' })).toBeNull()
    expect(sheet.queryByRole('button', { name: 'Control transcript' })).toBeNull()
  })
})
