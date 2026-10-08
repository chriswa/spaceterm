import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react'
import { FAKE_DEVICE_ID, installFakeBridge, type FakeBridge } from '@/testing/fake-bridge'
import { useReceptionistStore } from '@/stores/receptionistStore'
import { useControlTranscriptStore } from '@/stores/controlTranscriptStore'
import { ControlButton } from './ControlButton'
import { TranscriptButton } from './TranscriptButton'

let bridge: FakeBridge

beforeEach(() => {
  bridge = installFakeBridge()
  useReceptionistStore.setState({ phase: 'ready', target: false, error: null, holder: null, speaker: null, unread: { count: 0 } })
  useControlTranscriptStore.setState({ open: false, pending: [] })
})

afterEach(cleanup)

/** What the Control button asked the server for, in order. */
const holds = () => bridge.callsTo('receptionist.hold').map(call => call.args[0])

const hold = (muted = false) => act(() => {
  useReceptionistStore.getState().setHolder({ deviceId: FAKE_DEVICE_ID, label: 'Phone', ...(muted ? { muted: true as const } : {}) }, FAKE_DEVICE_ID)
})

describe('the phone’s Control button', () => {
  it('has Control speak here when it is elsewhere, and mutes it when it speaks here', () => {
    const { container } = render(<ControlButton />)
    const button = screen.getByRole('button', { name: /^Control/ })
    expect(container.querySelector('.m-control--away')).not.toBeNull()
    fireEvent.click(button)
    expect(holds()).toEqual(['speak-here'])

    hold()
    act(() => useReceptionistStore.getState().setStatus({ phase: 'ready', target: true }))
    expect(container.querySelector('.m-control--here')).not.toBeNull()
    fireEvent.click(button)
    expect(holds().at(-1)).toBe('mute')

    hold(true)
    expect(container.querySelector('.m-control--muted .m-control__muted')).not.toBeNull()
    fireEvent.click(button)
    expect(holds().at(-1)).toBe('speak-here')
  })

  it('names the device that holds Control, and talks Control back from Summary Chat', () => {
    const { container } = render(<ControlButton />)
    act(() => useReceptionistStore.getState().setHolder({ deviceId: 'desktop', label: 'Mac' }, FAKE_DEVICE_ID))
    expect(container.querySelector('.m-control__where')?.textContent).toBe('Mac')

    hold()
    act(() => useReceptionistStore.getState().setStatus({ phase: 'ready', target: false }))
    expect(container.querySelector('.m-control--summary')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Control/ }))
    expect(holds()).toEqual(['speak-here'])
  })

  it('shows thinking, but never speaking: that is the transcript button’s', () => {
    render(<ControlButton />)
    hold()
    act(() => useReceptionistStore.getState().setStatus({ phase: 'thinking', target: true }))
    const button = screen.getByRole('button', { name: /^Control/ })
    expect(button.dataset.phase).toBe('thinking')
    act(() => useReceptionistStore.getState().setStatus({ phase: 'speaking', target: true, speaker: 'Control' }))
    expect(button.dataset.phase).toBe('ready')
  })
})

describe('the phone’s transcript button', () => {
  it('opens and closes the transcript with a tap', () => {
    render(<TranscriptButton />)
    fireEvent.click(screen.getByRole('button', { name: /^Control transcript/ }))
    expect(useControlTranscriptStore.getState().open).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Close the Control transcript' }))
    expect(useControlTranscriptStore.getState().open).toBe(false)
  })

  it('says who is speaking, and counts what is unread', () => {
    const { container } = render(<TranscriptButton />)
    act(() => useReceptionistStore.getState().setStatus({ phase: 'speaking', target: true, speaker: 'Kevin' }))
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Control transcript — Kevin speaking')
    expect(container.querySelector('.m-transcript__bars')).not.toBeNull()
    act(() => useReceptionistStore.getState().setStatus({ phase: 'ready', target: true }))
    act(() => useReceptionistStore.getState().setUnread({ count: 2, first: 40 }))
    expect(container.querySelector('.m-transcript__count')?.textContent).toBe('2')
    expect(container.querySelector('.m-transcript__bars')).toBeNull()
  })
})
