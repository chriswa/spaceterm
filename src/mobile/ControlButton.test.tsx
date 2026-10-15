import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react'
import { FAKE_DEVICE_ID, installFakeBridge, type FakeBridge } from '@/testing/fake-bridge'
import { useReceptionistStore } from '@/stores/receptionistStore'
import { useControlTranscriptStore } from '@/stores/controlTranscriptStore'
import { ControlButton } from './ControlButton'

let bridge: FakeBridge

beforeEach(() => {
  bridge = installFakeBridge()
  useReceptionistStore.setState({ phase: 'ready', error: null, holder: null, mutedHere: false, speaker: null, unread: { count: 0 } })
  useControlTranscriptStore.setState({ open: false, pending: [] })
})

afterEach(cleanup)

const hold = (muted = false) => act(() => {
  useReceptionistStore.getState().setHolder({ deviceId: FAKE_DEVICE_ID, label: 'Phone', ...(muted ? { muted: true as const } : {}) }, FAKE_DEVICE_ID)
})

const button = () => screen.getByRole('button', { name: /Control transcript/ })

describe('the phone’s Control button', () => {
  it('only opens and closes the transcript, never moving or muting Control', () => {
    render(<ControlButton />)
    fireEvent.click(button())
    expect(useControlTranscriptStore.getState().open).toBe(true)
    fireEvent.click(button())
    expect(useControlTranscriptStore.getState().open).toBe(false)
    expect(bridge.callsTo('receptionist.hold')).toHaveLength(0)
  })

  it('is crossed out unless Control is here, and names the holder while it is elsewhere', () => {
    const { container } = render(<ControlButton />)
    expect(container.querySelector('.control-cross')).not.toBeNull()
    expect(container.querySelector('.control-badge--where')).toBeNull()
    expect(button().getAttribute('aria-label')).toMatch(/Control is unattached/)

    act(() => useReceptionistStore.getState().setHolder({ deviceId: 'desktop', label: 'Mac' }, FAKE_DEVICE_ID))
    expect(container.querySelector('.control-badge--where')?.textContent).toBe('Mac')
    expect(container.querySelector('.control-cross')).not.toBeNull()

    hold()
    expect(container.querySelector('.control-cross')).toBeNull()
    expect(container.querySelector('.control-badge--where')).toBeNull()
    expect(button().getAttribute('aria-label')).toMatch(/Control is attached here/)
  })

  it('has sound coming from the headset only while Control speaks here: not released, not in text', () => {
    const { container } = render(<ControlButton />)
    const sound = () => container.querySelector('.control-headset__sound')
    expect(sound()).toBeNull()

    hold()
    expect(sound()).not.toBeNull()
    expect(button().getAttribute('aria-label')).toMatch(/Control is attached here, speaking aloud/)

    hold(true)
    expect(sound()).toBeNull()
    expect(container.querySelector('.control-cross')).toBeNull()
    expect(button().getAttribute('aria-label')).toMatch(/Control is attached here, in text/)

    // Released while the server remembers this phone unmuted: still no sound.
    act(() => useReceptionistStore.getState().setHolder(null, FAKE_DEVICE_ID, []))
    expect(sound()).toBeNull()
  })

  it('is filled while the transcript is open, still showing the X, or the sound', () => {
    const { container } = render(<ControlButton />)
    fireEvent.click(button())
    expect(button().classList.contains('m-control--open')).toBe(true)
    expect(container.querySelector('.control-headset')).not.toBeNull()
    expect(container.querySelector('.control-cross')).not.toBeNull()
    hold()
    expect(container.querySelector('.control-headset__sound')).not.toBeNull()
  })

  it('shows thinking, who is speaking, and what is unread', () => {
    const { container } = render(<ControlButton />)
    hold()
    act(() => useReceptionistStore.getState().setStatus({ phase: 'thinking' }))
    expect(button().dataset.phase).toBe('thinking')

    act(() => useReceptionistStore.getState().setStatus({ phase: 'speaking', speaker: 'Kevin' }))
    expect(button().dataset.phase).toBe('ready')
    expect(button().getAttribute('aria-label')).toMatch(/Kevin speaking/)
    expect(button().classList.contains('m-control--speaking')).toBe(true)
    expect(container.querySelector('.control-headset')).not.toBeNull()

    act(() => useReceptionistStore.getState().setStatus({ phase: 'ready' }))
    act(() => useReceptionistStore.getState().setUnread({ count: 2, first: 40 }))
    expect(container.querySelector('.control-badge--count')?.textContent).toBe('2')
    expect(button().classList.contains('m-control--speaking')).toBe(false)
  })
})
