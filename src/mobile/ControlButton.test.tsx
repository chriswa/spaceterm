import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react'
import { FAKE_DEVICE_ID, installFakeBridge, type FakeBridge } from '@/testing/fake-bridge'
import { useReceptionistStore } from '@/stores/receptionistStore'
import { ControlButton } from './ControlButton'
import { SummarizerButton } from './SummarizerButton'

let bridge: FakeBridge

beforeEach(() => {
  bridge = installFakeBridge()
  useReceptionistStore.setState({ phase: 'ready', target: false, error: null, holder: null })
})

afterEach(cleanup)

describe('the phone’s Control button', () => {
  it('selects the receptionist, and its colour is where Control is', () => {
    const { container } = render(<ControlButton />)
    const button = screen.getByRole('button', { name: /^Control/ })
    fireEvent.click(button)
    expect(bridge.callsTo('receptionist.select')).toHaveLength(1)
    expect(container.querySelector('.m-control--away')).not.toBeNull()

    act(() => useReceptionistStore.getState().setHolder({ deviceId: FAKE_DEVICE_ID, label: 'Phone' }, FAKE_DEVICE_ID))
    act(() => useReceptionistStore.getState().setStatus({ phase: 'ready', target: true }))
    expect(container.querySelector('.m-control--here')).not.toBeNull()

    act(() => useReceptionistStore.getState().setStatus({ phase: 'speaking', target: true }))
    expect(button.dataset.phase).toBe('speaking')
    expect(button.getAttribute('aria-label')).toMatch(/stop it and let go/)

    act(() => useReceptionistStore.getState().setStatus({ phase: 'ready', target: false }))
    expect(container.querySelector('.m-control--summary')).not.toBeNull()
  })
})

describe('the talk button while Control holds the voice', () => {
  it('talks to Control even with no Summary Chat surface', () => {
    useReceptionistStore.setState({ target: true })
    render(<SummarizerButton nodeId={null} />)
    expect(screen.getByRole('button', { name: 'Talk to Control' })).toBeTruthy()
  })

  it('cuts Control off rather than Summary Chat when tapped over an answer', () => {
    useReceptionistStore.setState({ target: true, phase: 'speaking' })
    render(<SummarizerButton nodeId={null} />)
    fireEvent.click(screen.getByRole('button', { name: /Speaking/ }))
    // Stopped, not let go of: the select a Control press sends would silence it.
    expect(bridge.callsTo('receptionist.stop')).toHaveLength(1)
    expect(bridge.callsTo('receptionist.select')).toHaveLength(0)
    expect(bridge.callsTo('toggleSummaryChat')).toHaveLength(0)
  })
})
