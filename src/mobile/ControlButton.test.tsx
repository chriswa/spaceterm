import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react'
import { FAKE_DEVICE_ID, installFakeBridge, type FakeBridge } from '@/testing/fake-bridge'
import { useReceptionistStore } from '@/stores/receptionistStore'
import { useControlTranscriptStore } from '@/stores/controlTranscriptStore'
import { ControlButton } from './ControlButton'

let bridge: FakeBridge

beforeEach(() => {
  bridge = installFakeBridge()
  useReceptionistStore.setState({ phase: 'ready', target: false, error: null, holder: null, mutedHere: false, speaker: null, unread: { count: 0 } })
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
    expect(bridge.callsTo('receptionist.select')).toHaveLength(0)
  })

  it('wears an eye while Control is here, the holder’s name while it is elsewhere, and nothing while nobody has it', () => {
    const { container } = render(<ControlButton />)
    expect(container.querySelector('.control-badge--held, .control-badge--where')).toBeNull()
    expect(button().getAttribute('aria-label')).toMatch(/Nobody holds Control/)

    act(() => useReceptionistStore.getState().setHolder({ deviceId: 'desktop', label: 'Mac' }, FAKE_DEVICE_ID))
    expect(container.querySelector('.control-badge--where')?.textContent).toBe('Mac')
    expect(container.querySelector('.control-badge--held')).toBeNull()

    hold()
    expect(container.querySelector('.control-badge--held')).not.toBeNull()
    expect(container.querySelector('.control-badge--where')).toBeNull()
    expect(button().getAttribute('aria-label')).toMatch(/Control is here/)
  })

  it('crosses out its speech bubble while muted here, and fades it while Control is not here', () => {
    const { container } = render(<ControlButton />)
    const bubble = () => container.querySelector('.control-badge--voice')!
    expect(bubble().classList.contains('control-badge--faded')).toBe(true)
    expect(bubble().querySelector('[data-muted]')).toBeNull()

    hold(true)
    expect(bubble().classList.contains('control-badge--faded')).toBe(false)
    expect(bubble().querySelector('[data-muted]')).not.toBeNull()
    expect(button().getAttribute('aria-label')).toMatch(/muted here/)
  })

  it('shows thinking, who is speaking, and what is unread', () => {
    const { container } = render(<ControlButton />)
    hold()
    act(() => useReceptionistStore.getState().setStatus({ phase: 'thinking', target: true }))
    expect(button().dataset.phase).toBe('thinking')

    act(() => useReceptionistStore.getState().setStatus({ phase: 'speaking', target: true, speaker: 'Kevin' }))
    expect(button().dataset.phase).toBe('ready')
    expect(button().getAttribute('aria-label')).toMatch(/Kevin speaking/)
    expect(container.querySelector('.m-control__bars')).not.toBeNull()

    act(() => useReceptionistStore.getState().setStatus({ phase: 'ready', target: true }))
    act(() => useReceptionistStore.getState().setUnread({ count: 2, first: 40 }))
    expect(container.querySelector('.control-badge--count')?.textContent).toBe('2')
    expect(container.querySelector('.m-control__bars')).toBeNull()
  })

  it('is magenta while Control is here but the voice went to Summary Chat', () => {
    const { container } = render(<ControlButton />)
    hold()
    act(() => useReceptionistStore.getState().setStatus({ phase: 'ready', target: false }))
    expect(container.querySelector('.m-control--summary')).not.toBeNull()
  })
})
