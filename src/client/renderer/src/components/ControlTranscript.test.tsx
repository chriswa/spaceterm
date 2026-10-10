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
/** A bubble saying `text`, however its words are drawn. */
const findBubble = (text: string) => screen.findByText((_, el) => el?.classList.contains('control-transcript__bubble') === true && el.textContent === text)

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
    await findBubble('Want more?')
    const heads = [...document.querySelectorAll('.control-transcript__part .control-transcript__meta')].map((el) => el.textContent?.split(' · ')[0])
    expect(heads).toEqual(['Control', 'Kevin', 'Control'])
  })

  it('strikes out what was never heard of a reply, even when the mark arrives after it', async () => {
    bridge.responses.controlTranscript = () => ({
      entries: [{ offset: 0, timestamp: '2026-10-05T08:00:00Z', kind: 'reply', parts: [{ from: 'Control', text: 'Kevin is done.' }, { from: 'Kevin', text: 'The solver works.' }] }],
      more: false,
    })
    render(<ControlTranscript variant="modal" onDismiss={() => {}} />)
    await findBubble('Kevin is done.')
    expect(document.querySelector('.control-transcript__missed')).toBeNull()
    act(() => bridge.emit.transcriptAppended([{ offset: 90, timestamp: '2026-10-05T08:00:05Z', kind: 'heard', of: 0, parts: [14, 4] }]))
    const struck = [...document.querySelectorAll('.control-transcript__missed')]
    expect(struck.map((el) => el.textContent)).toEqual(['solver works.'])
    expect(struck[0].tagName).toBe('S')
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

  it('follows a message that keeps growing, though a scroll event arrives after it grew, but not a reader who scrolled up', async () => {
    // jsdom never resizes anything: the test says when the content grew.
    const grown: (() => void)[] = []
    vi.stubGlobal('ResizeObserver', class {
      constructor(private readonly callback: () => void) {}
      observe() { grown.push(this.callback) }
      unobserve() {}
      disconnect() {}
    })
    try {
      render(<ControlTranscript variant="screen" onDismiss={() => {}} />)
      await screen.findByText('Nothing said to Control yet')
      const list = document.querySelector('.control-transcript__list') as HTMLElement
      const grow = (scrollHeight: number) => {
        layout(list, scrollHeight, 500)
        grown.forEach((callback) => callback())
      }
      layout(list, 1000, 500)
      list.scrollTop = 500
      fireEvent.scroll(list)

      grow(1600)
      expect(list.scrollTop).toBe(1600)
      // The event for that scroll lands only once the message has grown again.
      layout(list, 2400, 500)
      fireEvent.scroll(list)
      grow(2400)
      expect(list.scrollTop).toBe(2400)

      // Scrolled up to read: what arrives next leaves them where they are.
      list.scrollTop = 1200
      fireEvent.scroll(list)
      grow(3000)
      expect(list.scrollTop).toBe(1200)
    } finally {
      vi.unstubAllGlobals()
    }
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

  it("shows Control's reasoning only while the Reasoning box is ticked, and remembers the choice", async () => {
    useControlTranscriptStore.getState().setReasoning(false)
    bridge.responses.controlTranscript = () => ({
      entries: [
        { offset: 0, timestamp: '2026-10-05T08:00:00Z', kind: 'trace', what: 'events', text: 'News: Sally is now stopped', detail: 'Sally said: done.' },
        { offset: 100, timestamp: '2026-10-05T08:00:01Z', kind: 'reply', parts: [] },
        { offset: 200, timestamp: '2026-10-05T08:00:01Z', kind: 'trace', what: 'watch', text: 'Watching Sally for its next stop' },
        { offset: 300, timestamp: '2026-10-05T08:00:02Z', kind: 'trace', what: 'failed', text: 'could not answer: session not found' },
      ],
      more: false,
    })
    render(<ControlTranscript variant="modal" onDismiss={() => {}} />)
    await screen.findByText('Control said nothing')
    expect(screen.queryByText('News: Sally is now stopped')).toBeNull()
    // A failure is shown regardless: Control said so out loud.
    expect(screen.getByText('could not answer: session not found').dataset.what).toBe('failed')

    fireEvent.click(screen.getByLabelText('Reasoning'))
    const news = screen.getByText('News: Sally is now stopped')
    expect(news.closest('details')!.dataset.what).toBe('events')
    expect(screen.getByText('Watching Sally for its next stop').dataset.what).toBe('watch')
    expect(localStorage.getItem('controlTranscript.reasoning')).toBe('true')

    // A reasoning line that arrives live waits for the box too.
    fireEvent.click(screen.getByLabelText('Reasoning'))
    act(() => bridge.emit.transcriptAppended([{ offset: 300, timestamp: '2026-10-05T08:00:02Z', kind: 'trace', what: 'backlog-add', text: 'Set aside for later: Sally' }]))
    expect(screen.queryByText('Set aside for later: Sally')).toBeNull()
    fireEvent.click(screen.getByLabelText('Reasoning'))
    expect(screen.getByText('Set aside for later: Sally')).toBeTruthy()
  })
})

describe('mergeEntries', () => {
  it('keeps each entry once, in record order, whichever way it arrived', () => {
    const merged = mergeEntries([user(100, 'b'), reply(200, 'c')], [user(0, 'a'), reply(200, 'c')])
    expect(merged.map((entry) => entry.offset)).toEqual([0, 100, 200])
  })
})

describe('the desktop dialog closes like a modal', () => {
  const wheel = (deltaX: number, deltaY = 0) => window.dispatchEvent(new WheelEvent('wheel', { deltaX, deltaY }))

  it('on a click outside it, but not on one inside it or on the buttons that toggle it', async () => {
    const onDismiss = vi.fn()
    const toggle = document.createElement('button')
    toggle.setAttribute('data-control-transcript-toggle', '')
    document.body.appendChild(toggle)
    render(<ControlTranscript variant="modal" onDismiss={onDismiss} />)
    await screen.findByText('Nothing said to Control yet')

    fireEvent.pointerDown(screen.getByPlaceholderText('Message Control'))
    fireEvent.pointerDown(toggle)
    expect(onDismiss).not.toHaveBeenCalled()

    // A press on the backdrop over the canvas is the backdrop's: it closes on the click.
    const backdrop = document.querySelector('.control-transcript-backdrop')!
    fireEvent.pointerDown(backdrop)
    expect(onDismiss).not.toHaveBeenCalled()
    fireEvent.click(backdrop)
    expect(onDismiss).toHaveBeenCalledTimes(1)

    // Anywhere else — the toolbar — closes it as well.
    fireEvent.pointerDown(document.body)
    expect(onDismiss).toHaveBeenCalledTimes(2)
    toggle.remove()
  })

  it('on a decisive sideways scroll, but not a vertical one or a sideways nudge', async () => {
    const onDismiss = vi.fn()
    render(<ControlTranscript variant="modal" onDismiss={onDismiss} />)
    await screen.findByText('Nothing said to Control yet')
    let now = 1000
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    wheel(0, 400)
    expect(onDismiss).not.toHaveBeenCalled()
    // A moment later, once that scroll has died away.
    now += 1000
    wheel(20)
    expect(onDismiss).not.toHaveBeenCalled()
    now += 1000
    wheel(60)
    now += 16
    wheel(60)
    expect(onDismiss).toHaveBeenCalled()
    clock.mockRestore()
  })

  it('not on the phone, whose screen a sideways drag dismisses instead', async () => {
    const onDismiss = vi.fn()
    render(<ControlTranscript variant="screen" onDismiss={onDismiss} />)
    await screen.findByText('Nothing said to Control yet')
    fireEvent.pointerDown(document.body)
    wheel(200)
    expect(onDismiss).not.toHaveBeenCalled()
    expect(document.querySelector('.control-transcript-backdrop')).toBeNull()
  })
})


describe('ControlTranscript and what the user took in', () => {
  const at = '2026-10-05T08:00:01Z'

  it('says where Control speaks, and moves it from its footer', async () => {
    useReceptionistStore.setState({ holder: { label: 'Phone', mine: true, muted: false }, mutedHere: false, unread: { count: 0 } })
    render(<ControlTranscript variant="modal" onDismiss={() => {}} />)
    await screen.findByText('Nothing said to Control yet')
    expect(screen.getByText('Control speaks here')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }))
    fireEvent.click(screen.getByRole('button', { name: 'Release' }))
    expect(bridge.callsTo('receptionist.hold').map((call) => call.args[0])).toEqual(['mute', 'release'])

    act(() => useReceptionistStore.setState({ holder: { label: 'Phone', mine: true, muted: true }, mutedHere: true, unread: { count: 2, first: 0 } }))
    fireEvent.click(screen.getByRole('button', { name: 'Unmute' }))
    fireEvent.click(screen.getByRole('button', { name: 'Catch me up · 2' }))
    expect(bridge.callsTo('receptionist.hold').at(-1)?.args[0]).toBe('unmute')
    expect(bridge.callsTo('receptionist.catchUp')).toHaveLength(1)
  })

  it('mutes and takes Control separately, so it can be muted before it is taken', async () => {
    useReceptionistStore.setState({ holder: { label: 'Mac', mine: false, muted: false }, mutedHere: false, unread: { count: 0 } })
    render(<ControlTranscript variant="modal" onDismiss={() => {}} />)
    await screen.findByText('Nothing said to Control yet')
    expect(screen.getByText('Control is on your Mac')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }))

    act(() => useReceptionistStore.setState({ mutedHere: true }))
    expect(screen.getByText('Control is on your Mac · muted here')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Take Control' }))
    expect(bridge.callsTo('receptionist.hold').map((call) => call.args[0])).toEqual(['mute', 'take'])
  })

  it('strikes out what was missed, and puts what waits under an Unread line until it is marked read', async () => {
    useReceptionistStore.setState({ unread: { count: 1, first: 120 } })
    bridge.responses.controlTranscript = () => ({
      entries: [
        { offset: 0, timestamp: at, kind: 'reply', parts: [{ from: 'Control', text: 'Kevin is done.' }, { from: 'Kevin', text: 'The solver works.' }] },
        { offset: 80, timestamp: at, kind: 'heard', of: 0, parts: [14, 4] },
        { offset: 120, timestamp: at, kind: 'reply', parts: [{ from: 'Control', text: 'Sally asks a question.' }], delivery: 'text' },
      ],
      more: false,
    })
    render(<ControlTranscript variant="modal" onDismiss={() => {}} />)
    await findBubble('Kevin is done.')
    expect(document.querySelector('.control-transcript__missed')?.textContent).toBe('solver works.')
    expect(document.querySelector('.control-transcript__waiting')?.textContent).toBe('Sally asks a question.')
    const line = document.querySelector('.control-transcript__unread-line')!
    expect(line.nextElementSibling?.textContent).toContain('Sally asks a question.')

    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }))
    expect(bridge.callsTo('receptionist.readAll')).toHaveLength(1)
    // Read: the record says so, and it is drawn whole.
    act(() => {
      bridge.emit.transcriptAppended([{ offset: 200, timestamp: at, kind: 'consumed', of: 120, part: 0, from: 0, to: 22, how: 'read' }])
      useReceptionistStore.setState({ unread: { count: 0 } })
    })
    expect(document.querySelector('.control-transcript__waiting')).toBeNull()
    expect(document.querySelector('.control-transcript__unread-line')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Mark all read' })).toBeNull()
  })

  it('marks where the user stopped at the word they click, in what Control said since their last message only', async () => {
    useReceptionistStore.setState({ phase: 'ready', unread: { count: 0 } })
    bridge.responses.controlTranscript = () => ({
      entries: [
        { offset: 0, timestamp: at, kind: 'reply', parts: [{ from: 'Control', text: 'Old news.' }] },
        { offset: 40, timestamp: at, kind: 'user', text: 'and Kevin?' },
        { offset: 80, timestamp: at, kind: 'reply', parts: [{ from: 'Control', text: 'Kevin is done.' }, { from: 'Kevin', text: 'The solver works.' }] },
        { offset: 160, timestamp: at, kind: 'heard', of: 80, parts: [14, 4] },
      ],
      more: false,
    })
    render(<ControlTranscript variant="modal" onDismiss={() => {}} />)
    await findBubble('Kevin is done.')
    // Struck, and still clickable: the word says how far.
    fireEvent.click(screen.getByText('solver'))
    expect(bridge.lastCall('receptionist.mark')).toEqual([80, 1, 'The solver'.length])
    // Heard, and clickable too: back to where they stopped.
    fireEvent.click(screen.getByText('is'))
    expect(bridge.lastCall('receptionist.mark')).toEqual([80, 0, 'Kevin is'.length])
    // The speaker's name: none of it from there.
    fireEvent.click(screen.getByRole('button', { name: 'Kevin' }))
    expect(bridge.lastCall('receptionist.mark')).toEqual([80, 1, 0])
    // Locked by the user's last message.
    expect(screen.getByText('Old news.').closest('.control-transcript__bubble--markable')).toBeNull()

    // Not while Control speaks: the voice says how far.
    act(() => useReceptionistStore.setState({ phase: 'speaking' }))
    expect(document.querySelector('.control-transcript__bubble--markable')).toBeNull()
    act(() => useReceptionistStore.setState({ phase: 'ready' }))
  })

  it('lights what the voice has said, and dims every part it has yet to reach', async () => {
    bridge.responses.controlTranscript = () => ({
      entries: [{ offset: 0, timestamp: at, kind: 'reply', parts: [
        { from: 'Control', text: 'Kevin is done.' }, { from: 'Kevin', text: 'Kevin here. The solver works.' }, { from: 'Ada', text: 'Ada here. Mine too.' },
      ] }],
      more: false,
    })
    render(<ControlTranscript variant="modal" onDismiss={() => {}} />)
    await findBubble('Kevin is done.')
    const unsaid = () => [...document.querySelectorAll('.control-transcript__unsaid')].map(span => span.textContent)
    act(() => bridge.emit.receptionistSpeaking({ of: 0, parts: [5, 0, 0] }))
    expect(unsaid()).toEqual([' is done.', 'Kevin here. The solver works.', 'Ada here. Mine too.'])
    act(() => bridge.emit.receptionistSpeaking({ of: 0, parts: [14, 22, 0] }))
    expect(unsaid()).toEqual([' works.', 'Ada here. Mine too.'])
    act(() => bridge.emit.receptionistSpeaking(null))
    expect(unsaid()).toEqual([])
  })

  it('plays a part again, and stops it', async () => {
    bridge.responses.controlTranscript = () => ({ entries: [{ offset: 0, timestamp: at, kind: 'reply', parts: [{ from: 'Kevin', text: 'The solver works.' }] }], more: false })
    render(<ControlTranscript variant="modal" onDismiss={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: "Play this again, in Kevin's voice" }))
    expect(bridge.lastCall('receptionist.replay')).toEqual([0, 0])
    act(() => bridge.emit.receptionistReplaying({ of: 0, part: 0 }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop playing this' }))
    expect(bridge.callsTo('receptionist.stopReplay')).toHaveLength(1)
  })

  it('asks Control to do an action that was never done', async () => {
    bridge.responses.controlTranscript = () => ({ entries: [{ offset: 0, timestamp: at, kind: 'log', text: 'SENT to Kevin: push it', notDone: true }], more: false })
    render(<ControlTranscript variant="modal" onDismiss={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Do it now' }))
    expect(bridge.lastCall('receptionist.say')).toEqual(['Please do this after all: SENT to Kevin: push it'])
  })
})
