import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import { ControlButton } from './ControlButtons'
import { Toolbar } from '../Toolbar'
import { FAKE_DEVICE_ID, installFakeBridge, type FakeBridge } from '../../testing/fake-bridge'
import { useReceptionistStore } from '../../stores/receptionistStore'
import { useControlTranscriptStore } from '../../stores/controlTranscriptStore'
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
  useReceptionistStore.setState({ phase: 'ready', target: false, error: null, holder: null, mutedHere: false, unread: { count: 0 } })
  useControlTranscriptStore.setState({ open: false })
})

afterEach(cleanup)

describe('ControlButton', () => {
  it('shows the transcript on a click and hides it on the next, and asks the server nothing', () => {
    const { container } = render(<ControlButton />)
    const button = container.querySelector('button')!
    fireEvent.click(button)
    expect(useControlTranscriptStore.getState().open).toBe(true)
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.className).toContain('toolbar__btn--active')
    fireEvent.click(button)
    expect(useControlTranscriptStore.getState().open).toBe(false)
    expect(bridge.callsTo('receptionist.select')).toHaveLength(0)
    expect(bridge.callsTo('receptionist.hold')).toHaveLength(0)
  })

  it('is dim elsewhere and magenta here with the voice on Summary Chat, and says where Control is', () => {
    const { container } = render(<ControlButton />)
    const button = container.querySelector('button')!
    heldBy('Phone')
    status({ phase: 'ready', target: true })
    expect(button.className).toContain('toolbar__control--away')
    expect(button.dataset.tooltip).toMatch(/Control is on your Phone, unmuted here\. Click to open the transcript/)
    expect(container.querySelector('.control-badge--where')?.textContent).toBe('Phone')

    heldBy('here')
    expect(button.className).toContain('toolbar__control--here')
    expect(container.querySelector('.control-badge--held')).not.toBeNull()

    status({ phase: 'ready', target: false })
    expect(button.className).toContain('toolbar__control--summary')
    expect(button.dataset.tooltip).toMatch(/Summary Chat/)
  })

  it('swaps the eye for the Summary Chat bubble while Control works here', () => {
    heldBy('here')
    const { container } = render(<ControlButton />)
    status({ phase: 'ready', target: true })
    expect(container.querySelector('.toolbar__summary-bubble')).toBeNull()
    expect(container.querySelector('.control-badge--held')).not.toBeNull()

    status({ phase: 'synthesizing', target: true })
    expect(container.querySelector('.toolbar__summary-bubble--thinking')).not.toBeNull()
    expect(container.querySelector('.control-badge--held')).toBeNull()

    status({ phase: 'speaking', target: false })
    expect(container.querySelector('.toolbar__summary-bubble--talking')).not.toBeNull()

    heldBy('Phone')
    expect(container.querySelector('.toolbar__summary-bubble')).toBeNull()
  })

  it('crosses out its speech bubble while muted here', () => {
    const { container } = render(<ControlButton />)
    expect(container.querySelector('.control-badge--voice [data-muted]')).toBeNull()
    act(() => useReceptionistStore.getState().setHolder({ deviceId: FAKE_DEVICE_ID, label: 'Mac', muted: true }, FAKE_DEVICE_ID))
    expect(container.querySelector('.control-badge--voice [data-muted]')).not.toBeNull()
    expect(container.querySelector('button')!.dataset.tooltip).toMatch(/muted here/)
  })

  it('says why it failed', () => {
    const { container } = render(<ControlButton />)
    status({ phase: 'ready', target: false, message: 'no API key' })
    expect(container.querySelector('button')!.dataset.tooltip).toMatch(/^Control — no API key\./)
  })
})

describe('the phone toolbar sheet', () => {
  it('leaves out Control, which the bottom bar covers', () => {
    const host = {
      onHelpClick: () => {}, keycastEnabled: false, onKeycastToggle: () => {}, onDebugCapture: () => {},
      onInertiaLogDump: () => {}, restartingSpaceterm: false, onRestartSpaceterm: () => {}, crabs: [],
      onCrabClick: () => {}, onCrabReorder: () => {}, selectedNodeId: null, crabNavEvent: null, now: 0, onStepOut: () => {}
    }
    const bar = render(<Toolbar {...host} />)
    expect(bar.queryByRole('button', { name: 'Control' })).not.toBeNull()
    bar.unmount()

    const sheet = render(<Toolbar {...host} variant="sheet" />)
    expect(sheet.queryByRole('button', { name: 'Control' })).toBeNull()
  })
})
