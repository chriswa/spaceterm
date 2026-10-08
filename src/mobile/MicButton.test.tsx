import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react'
import { installFakeBridge, type FakeBridge } from '@/testing/fake-bridge'
import { useReceptionistStore } from '@/stores/receptionistStore'
import { useControlTranscriptStore } from '@/stores/controlTranscriptStore'
import { asNodeId } from '../shared/ids'
import { holdState, setHoldMicrophone } from './held-microphone'
import { useDictationSession } from './dictation-session'
import { LOCK_PX, LONG_PRESS_MS } from './mic-button'
import { MicButton } from './MicButton'

const NODE = asNodeId('n1')
let bridge: FakeBridge

beforeEach(() => {
  bridge = installFakeBridge()
  useReceptionistStore.setState({ phase: 'ready', target: false, error: null, holder: null })
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  setHoldMicrophone(false)
  useDictationSession.setState({ mic: { kind: 'idle' } })
})

const mic = () => screen.getByRole('button', { name: /Talk to|Cut .* off|dictating/ })

function longPress(button: HTMLElement) {
  vi.useFakeTimers()
  fireEvent.pointerDown(button, { clientX: 100, clientY: 500 })
  act(() => { vi.advanceTimersByTime(LONG_PRESS_MS) })
  // The release's click must not also start listening.
  fireEvent.pointerUp(button)
  fireEvent.click(button)
}

describe('the microphone’s long press', () => {
  it('offers to abandon Summary Chat, and abandoning ends it without listening', () => {
    render(<MicButton nodeId={NODE} />)
    longPress(mic())
    expect(bridge.callsTo('dictation.start')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Abandon summarizer' }))
    expect(bridge.callsTo('endSummaryChat')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Abandon summarizer' })).toBeNull()
  })

  it('keeps the conversation when the sheet is tapped outside', () => {
    const { container } = render(<MicButton nodeId={NODE} />)
    longPress(mic())
    fireEvent.click(container.ownerDocument.querySelector('.m-mic-sheet') as HTMLElement)
    expect(screen.queryByRole('button', { name: 'Abandon summarizer' })).toBeNull()
    expect(bridge.callsTo('endSummaryChat')).toHaveLength(0)
  })

  it('does nothing while talking to Control, which has nothing to offer there', () => {
    render(<MicButton nodeId={null} />)
    longPress(mic())
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(bridge.callsTo('dictation.start')).toHaveLength(0)
  })
})

describe('dragging the microphone up', () => {
  it('shows the lock, switches hands-free on reaching it, and is not a tap', () => {
    const { container } = render(<MicButton nodeId={null} />)
    const button = mic()
    expect(button.getAttribute('aria-label')).toMatch(/drag up to always listen|drag up to hold/)
    fireEvent.pointerDown(button, { clientX: 100, clientY: 500 })
    fireEvent.pointerMove(button, { clientX: 100, clientY: 480 })
    expect(container.querySelector('.m-mic-lock')).not.toBeNull()
    expect(container.querySelector('.m-mic-lock--reached')).toBeNull()
    fireEvent.pointerMove(button, { clientX: 100, clientY: 500 - LOCK_PX })
    expect(container.querySelector('.m-mic-lock--reached')).not.toBeNull()
    fireEvent.pointerUp(button, { clientX: 100, clientY: 500 - LOCK_PX })
    fireEvent.click(button)
    expect(holdState()).not.toBe('off')
    expect(bridge.callsTo('dictation.start')).toHaveLength(0)
    expect(container.querySelector('.m-mic-lock')).toBeNull()
    expect(mic().getAttribute('aria-label')).toMatch(/drag up to stop listening/)

    // And again, off.
    fireEvent.pointerDown(mic(), { clientX: 100, clientY: 500 })
    fireEvent.pointerMove(mic(), { clientX: 100, clientY: 500 - LOCK_PX })
    expect(container.querySelector('.m-mic-lock')!.textContent).toMatch(/Stop listening/)
    fireEvent.pointerUp(mic())
    expect(holdState()).toBe('off')
  })
})

describe('the microphone while Control holds the voice', () => {
  it('talks to Control even with no Summary Chat surface', () => {
    useReceptionistStore.setState({ target: true })
    render(<MicButton nodeId={null} />)
    expect(screen.getByRole('button', { name: /^Talk to Control/ })).toBeTruthy()
  })

  it('never shows what Control is doing, yet a tap still cuts Control off rather than Summary Chat', () => {
    useReceptionistStore.setState({ target: true, phase: 'speaking' })
    const { container } = render(<MicButton nodeId={null} />)
    expect(container.querySelector('.m-mic--off')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Cut Control off and talk/ }))
    // Stopped, not let go of: the select a Control press sends would silence it.
    expect(bridge.callsTo('receptionist.stop')).toHaveLength(1)
    expect(bridge.callsTo('receptionist.select')).toHaveLength(0)
    expect(bridge.callsTo('toggleSummaryChat')).toHaveLength(0)
  })
})

describe('the microphone over Control’s transcript', () => {
  it('sends what it hears straight to Control, and shows it at the bottom of the transcript', async () => {
    act(() => useControlTranscriptStore.getState().setOpen(true))
    const finish = vi.fn(async () => 'what is Kevin doing?')
    const dictation = await import('./dictation')
    vi.spyOn(dictation.Dictation, 'begin').mockReturnValue({} as never)
    vi.spyOn(dictation, 'whenHearing').mockResolvedValue({ finish, cancel: vi.fn() } as never)
    const { container } = render(<MicButton nodeId={null} />)
    fireEvent.click(screen.getByRole('button', { name: /^Talk to Control/ }))
    await screen.findByRole('button', { name: 'Listening — tap to send' })
    expect(container.querySelector('.m-mic--hearing')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Listening — tap to send' }))
    await screen.findByRole('button', { name: /^Talk to Control/ })
    expect(bridge.lastCall('receptionist.say')).toEqual(['what is Kevin doing?'])
    expect(bridge.callsTo('summaryChatFollowUp')).toHaveLength(0)
    expect(useControlTranscriptStore.getState().pending).toEqual(['what is Kevin doing?'])
    act(() => useControlTranscriptStore.getState().setOpen(false))
    vi.restoreAllMocks()
  })
})

describe('a composer’s dictation still running', () => {
  it('turns the microphone orange, and a tap goes back to a composer instead of talking', () => {
    useDictationSession.setState({ mic: { kind: 'listening', dictation: {} as never } })
    const reopen = vi.fn()
    const { container } = render(<MicButton nodeId={null} talk={false} onReopenComposer={reopen} />)
    expect(container.querySelector('.m-mic--hearing')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /tap to open the composer/ }))
    expect(reopen).toHaveBeenCalledTimes(1)
    expect(bridge.callsTo('dictation.start')).toHaveLength(0)
  })

  it('with nowhere to reopen it, only says so', () => {
    useDictationSession.setState({ mic: { kind: 'listening', dictation: {} as never } })
    render(<MicButton nodeId={null} talk={false} />)
    fireEvent.click(screen.getByRole('button', { name: /open a composer to stop or ship it/ }))
    expect(bridge.callsTo('dictation.start')).toHaveLength(0)
  })
})
