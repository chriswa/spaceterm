import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react'
import { installFakeBridge, type FakeBridge } from '@/testing/fake-bridge'
import { useReceptionistStore } from '@/stores/receptionistStore'
import { ControlButton } from './ControlButton'
import { SummarizerButton } from './SummarizerButton'

let bridge: FakeBridge

beforeEach(() => {
  bridge = installFakeBridge()
  useReceptionistStore.setState({ phase: 'ready', target: false, error: null, talkToMe: true })
})

afterEach(cleanup)

describe('the phone’s Control button', () => {
  it('selects the receptionist, and its colour is the server’s state', () => {
    const { container } = render(<ControlButton />)
    const button = screen.getByRole('button', { name: /^Control/ })
    fireEvent.click(button)
    expect(bridge.callsTo('receptionist.select')).toHaveLength(1)
    expect(container.querySelector('.m-control--idle')).not.toBeNull()

    act(() => useReceptionistStore.getState().setStatus({ phase: 'ready', target: true }))
    expect(container.querySelector('.m-control--target')).not.toBeNull()

    act(() => useReceptionistStore.getState().setStatus({ phase: 'speaking', target: true }))
    expect(container.querySelector('.m-control--speaking')).not.toBeNull()
    expect(button.getAttribute('aria-label')).toMatch(/stop/)
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
    expect(bridge.callsTo('receptionist.select')).toHaveLength(1)
    expect(bridge.callsTo('toggleSummaryChat')).toHaveLength(0)
  })
})
