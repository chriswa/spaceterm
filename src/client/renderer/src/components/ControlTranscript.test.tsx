import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, act, screen, waitFor } from '@testing-library/react'
import { ControlTranscript, mergeEntries } from './ControlTranscript'
import { installFakeBridge, type FakeBridge } from '../testing/fake-bridge'
import { useControlTranscriptStore } from '../stores/controlTranscriptStore'
import { useReceptionistStore } from '../stores/receptionistStore'
import type { ControlTranscriptEntry } from '../../../../shared/protocol'

let bridge: FakeBridge

const user = (offset: number, text: string): ControlTranscriptEntry => ({ offset, timestamp: '2026-10-05T08:00:00Z', kind: 'user', text })
const reply = (offset: number, text: string): ControlTranscriptEntry => ({ offset, timestamp: '2026-10-05T08:00:01Z', kind: 'reply', parts: [{ from: 'Control', text }] })

beforeEach(() => {
  bridge = installFakeBridge(globalThis as never)
  // Open, as it always is while drawn, with nothing left pending from the last test.
  useControlTranscriptStore.getState().setOpen(false)
  useControlTranscriptStore.getState().setOpen(true)
})

afterEach(cleanup)

describe('ControlTranscript', () => {
  it('opens on the newest page, then loads older ones from the oldest entry it has', async () => {
    bridge.responses.controlTranscript = (before) => before === undefined
      ? { entries: [user(100, 'newer question'), reply(200, 'newer answer')], more: true }
      : { entries: [user(0, 'oldest question')], more: false }
    render(<ControlTranscript variant="modal" onDismiss={() => {}} />)
    // jsdom lays nothing out, so the page never fills the view: it keeps loading until the start.
    await screen.findByText('oldest question')
    expect(bridge.callsTo('receptionist.transcript').map((call) => call.args[0])).toEqual([undefined, 100])
    expect(screen.getByText('The start of the conversation')).toBeTruthy()
    const texts = [...document.querySelectorAll('.control-transcript__bubble')].map((el) => el.textContent)
    expect(texts).toEqual(['oldest question', 'newer question', 'newer answer'])
  })

  it('sends what is typed, shows it as on its way, and settles it when the record has it', async () => {
    render(<ControlTranscript variant="modal" onDismiss={() => {}} />)
    await screen.findByText('Nothing said to Control yet')
    const box = screen.getByPlaceholderText('Message Control')
    fireEvent.change(box, { target: { value: '  what is Kevin doing?  ' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(bridge.lastCall('receptionist.say')).toEqual(['what is Kevin doing?'])
    expect((box as HTMLTextAreaElement).value).toBe('')
    expect(document.querySelector('.control-transcript__entry--pending')?.textContent).toBe('what is Kevin doing?')

    act(() => bridge.emit.transcriptAppended([user(500, 'what is Kevin doing?'), reply(600, 'Testing.')]))
    expect(document.querySelector('.control-transcript__entry--pending')).toBeNull()
    expect(screen.getByText('Testing.')).toBeTruthy()
  })

  it('keeps a newline on shift-enter, and sends nothing empty', async () => {
    render(<ControlTranscript variant="modal" onDismiss={() => {}} />)
    const box = screen.getByPlaceholderText('Message Control')
    fireEvent.keyDown(box, { key: 'Enter' })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(bridge.callsTo('receptionist.say')).toHaveLength(0)
    await waitFor(() => expect(bridge.callsTo('receptionist.transcript')).toHaveLength(1))
  })

  it('closes on Escape, and has no header of its own to close it with', async () => {
    const onDismiss = vi.fn()
    render(<ControlTranscript variant="screen" onDismiss={onDismiss} />)
    fireEvent.keyDown(screen.getByPlaceholderText('Message Control'), { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
    await waitFor(() => expect(bridge.callsTo('receptionist.transcript')).toHaveLength(1))
  })
})

describe('ControlTranscript entries', () => {
  it('heads every change of voice, so Control after a quote is Control again', async () => {
    bridge.responses.controlTranscript = () => ({
      entries: [{
        offset: 0, timestamp: '2026-10-05T08:00:00Z', kind: 'reply',
        parts: [{ from: 'Control', text: 'Kevin says:' }, { from: 'Kevin', text: 'All green.' }, { from: 'Control', text: 'Want more?' }, { from: 'Control', text: 'Or not.' }],
      }],
      more: false,
    })
    render(<ControlTranscript variant="modal" onDismiss={() => {}} />)
    await screen.findByText('Want more?')
    const heads = [...document.querySelectorAll('.control-transcript__part .control-transcript__meta')].map((el) => el.textContent?.split(' · ')[0])
    expect(heads).toEqual(['Control', 'Kevin', 'Control'])
  })

  it('strikes out what was never heard of a reply, even when the mark arrives after it', async () => {
    bridge.responses.controlTranscript = () => ({
      entries: [{ offset: 0, timestamp: '2026-10-05T08:00:00Z', kind: 'reply', parts: [{ from: 'Control', text: 'Kevin is done.' }, { from: 'Kevin', text: 'The solver works.' }] }],
      more: false,
    })
    render(<ControlTranscript variant="modal" onDismiss={() => {}} />)
    await screen.findByText('Kevin is done.')
    expect(document.querySelector('.control-transcript__unheard')).toBeNull()
    act(() => bridge.emit.transcriptAppended([{ offset: 90, timestamp: '2026-10-05T08:00:05Z', kind: 'heard', of: 0, parts: [14, 4] }]))
    const struck = [...document.querySelectorAll('.control-transcript__unheard')].map((el) => el.textContent)
    expect(struck).toEqual(['solver works.'])
    expect(document.querySelectorAll('.control-transcript__entry')).toHaveLength(1)
  })

  it("shows what Control did as one collapsed line, the rest on opening it", async () => {
    bridge.responses.controlTranscript = () => ({
      entries: [{ offset: 0, timestamp: '2026-10-05T08:00:00Z', kind: 'log', text: 'SENT TO Tessa: a long message' }],
      more: false,
    })
    render(<ControlTranscript variant="modal" onDismiss={() => {}} />)
    const summary = await screen.findByText('SENT TO Tessa')
    const details = summary.closest('details')!
    expect(details.open).toBe(false)
    expect(details.textContent).toContain('a long message')
  })
})

describe('ControlTranscript, following along', () => {
  /** Lay the list out as a browser would: jsdom lays nothing out. */
  function layout(list: HTMLElement, scrollHeight: number, clientHeight: number): void {
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: scrollHeight })
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: clientHeight })
  }

  it('shows a thinking circle only while Control is thinking', async () => {
    render(<ControlTranscript variant="modal" onDismiss={() => {}} />)
    await screen.findByText('Nothing said to Control yet')
    act(() => useReceptionistStore.setState({ phase: 'thinking' }))
    expect(screen.getByRole('status', { name: 'Control is thinking' })).toBeTruthy()
    act(() => useReceptionistStore.setState({ phase: 'speaking' }))
    expect(screen.queryByRole('status', { name: 'Control is thinking' })).toBeNull()
    act(() => useReceptionistStore.setState({ phase: 'ready' }))
  })

  it('offers a way back to the bottom only when scrolled up from it, and sending goes back there', async () => {
    render(<ControlTranscript variant="modal" onDismiss={() => {}} />)
    await screen.findByText('Nothing said to Control yet')
    const list = document.querySelector('.control-transcript__list') as HTMLElement
    layout(list, 2000, 500)
    list.scrollTop = 1500
    fireEvent.scroll(list)
    expect(screen.queryByRole('button', { name: 'Scroll to the newest' })).toBeNull()

    list.scrollTop = 600
    fireEvent.scroll(list)
    expect(screen.getByRole('button', { name: 'Scroll to the newest' })).toBeTruthy()

    // Sending from up there lands at the bottom, to see it go.
    const box = screen.getByPlaceholderText('Message Control')
    fireEvent.change(box, { target: { value: 'and Sally?' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(list.scrollTop).toBe(2000)
  })

  it('strikes out an action that never ran, and says so', async () => {
    bridge.responses.controlTranscript = () => ({
      entries: [{ offset: 0, timestamp: '2026-10-05T08:00:00Z', kind: 'log', text: 'SENT TO Sally: Push it.', notDone: true }],
      more: false,
    })
    render(<ControlTranscript variant="modal" onDismiss={() => {}} />)
    const struck = await screen.findByText('SENT TO Sally')
    expect(struck.tagName).toBe('S')
    expect(struck.closest('summary')!.textContent).toMatch(/not done, cut off/)
    expect(struck.closest('details')!.dataset.action).toBe('sent')
  })
})

describe('mergeEntries', () => {
  it('keeps each entry once, in record order, whichever way it arrived', () => {
    const merged = mergeEntries([user(100, 'b'), reply(200, 'c')], [user(0, 'a'), reply(200, 'c')])
    expect(merged.map((entry) => entry.offset)).toEqual([0, 100, 200])
  })
})
