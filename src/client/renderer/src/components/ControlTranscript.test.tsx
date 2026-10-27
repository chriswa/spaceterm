import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, act, screen, waitFor, within } from '@testing-library/react'
import { ControlTranscript, followScroll, holdActions, mergeEntries } from './ControlTranscript'
import { installFakeBridge, type FakeBridge } from '../testing/fake-bridge'
import { useControlTranscriptStore } from '../stores/controlTranscriptStore'
import { useReceptionistStore } from '../stores/receptionistStore'
import { useNodeStore } from '../stores/nodeStore'
import { useSurfacePresenterStore } from '../stores/surfacePresenterStore'
import type { ControlTranscriptEntry } from '../../../../shared/protocol'
import type { ArchivedNode, NodeData } from '../../../../shared/state'
import { asNodeId, ROOT_NODE_ID } from '../../../../shared/ids'

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
  useControlTranscriptStore.getState().setDraft('')
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

  it('keeps what is typed and not sent through closing and reopening, and remembers it on this device', async () => {
    const first = render(<ControlTranscript variant="modal" onDismiss={() => {}} />)
    await screen.findByText('Nothing said to Control yet')
    fireEvent.change(screen.getByPlaceholderText('Message Control'), { target: { value: 'half a thought' } })
    first.unmount()
    // Closing clears what was pending, never the draft.
    useControlTranscriptStore.getState().setOpen(false)
    useControlTranscriptStore.getState().setOpen(true)
    expect(localStorage.getItem('controlTranscript.draft')).toBe('half a thought')

    render(<ControlTranscript variant="modal" onDismiss={() => {}} />)
    await screen.findByText('Nothing said to Control yet')
    const box = screen.getByPlaceholderText('Message Control') as HTMLTextAreaElement
    expect(box.value).toBe('half a thought')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(bridge.lastCall('receptionist.say')).toEqual(['half a thought'])
    expect(localStorage.getItem('controlTranscript.draft')).toBeNull()
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

  it("shows Control's activity only while Verbose is on, and remembers the choice", async () => {
    useControlTranscriptStore.getState().setActivity(false)
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

    fireEvent.click(screen.getByRole('button', { name: 'Verbose' }))
    const news = screen.getByText('News: Sally is now stopped')
    expect(news.closest('details')!.dataset.what).toBe('events')
    expect(screen.getByText('Watching Sally for its next stop').dataset.what).toBe('watch')
    expect(localStorage.getItem('controlTranscript.activity')).toBe('true')

    // An activity line that arrives live waits for the choice too.
    fireEvent.click(screen.getByRole('button', { name: 'Verbose' }))
    act(() => bridge.emit.transcriptAppended([{ offset: 300, timestamp: '2026-10-05T08:00:02Z', kind: 'trace', what: 'backlog-add', text: 'Set aside for later: Sally' }]))
    expect(screen.queryByText('Set aside for later: Sally')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Verbose' }))
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

  const chosen = () => within(screen.getByRole('radiogroup', { name: 'Control on this device' })).getAllByRole('radio').filter((el) => el.getAttribute('aria-checked') === 'true').map((el) => el.textContent)

  it('shows Control as Off, Read or Hear, and moves it from its footer', async () => {
    useReceptionistStore.setState({ holder: { label: 'Phone', mine: true, muted: false }, mutedHere: false, unread: { count: 0 } })
    render(<ControlTranscript variant="modal" onDismiss={() => {}} />)
    await screen.findByText('Nothing said to Control yet')
    expect(chosen()).toEqual(['Hear'])
    expect(screen.queryByText('Control speaks here')).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: 'Hear' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Read' }))
    expect(bridge.callsTo('receptionist.hold').map((call) => call.args[0])).toEqual(['mute'])

    act(() => useReceptionistStore.setState({ holder: { label: 'Phone', mine: true, muted: true }, mutedHere: true, unread: { count: 2, first: 0 } }))
    expect(chosen()).toEqual(['Read'])
    fireEvent.click(screen.getByRole('radio', { name: 'Off' }))
    expect(bridge.callsTo('receptionist.hold').at(-1)?.args[0]).toBe('release')
  })

  it('shows Hold backlog as the server has it, and asks the server to change it', async () => {
    useReceptionistStore.setState({ backlogHeld: false })
    render(<ControlTranscript variant="modal" onDismiss={() => {}} />)
    await screen.findByText('Nothing said to Control yet')
    const hold = screen.getByRole('button', { name: 'Hold backlog' })
    expect(hold.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(hold)
    expect(bridge.callsTo('receptionist.holdBacklog').map((call) => call.args[0])).toEqual([true])
    // Pressed only once the server says so.
    expect(hold.getAttribute('aria-pressed')).toBe('false')
    act(() => useReceptionistStore.getState().setBacklog({ count: 0, held: true, items: [] }))
    expect(hold.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(hold)
    expect(bridge.callsTo('receptionist.holdBacklog').at(-1)?.args[0]).toBe(false)
  })

  it('is Off while another device holds Control, muted here or not', async () => {
    useReceptionistStore.setState({ holder: { label: 'Mac', mine: false, muted: false }, mutedHere: true, unread: { count: 0 } })
    render(<ControlTranscript variant="modal" onDismiss={() => {}} />)
    await screen.findByText('Nothing said to Control yet')
    expect(chosen()).toEqual(['Off'])
    fireEvent.click(screen.getByRole('radio', { name: 'Hear' }))
    expect(bridge.callsTo('receptionist.hold').map((call) => call.args[0])).toEqual(['speak-here'])
  })
  it('offers what waits unread read aloud in any mode, and marking it read, with no count', async () => {
    useReceptionistStore.setState({ holder: { label: 'Mac', mine: false, muted: false }, mutedHere: true, unread: { count: 2, first: 0 } })
    render(<ControlTranscript variant="modal" onDismiss={() => {}} />)
    await screen.findByText('Nothing said to Control yet')
    const bar = () => within(screen.getByRole('group', { name: 'Unread replies' }))
    expect(bar().queryByText(/unread/)).toBeNull()
    fireEvent.click(bar().getByRole('button', { name: 'Read aloud' }))
    expect(bridge.callsTo('receptionist.readAloud')).toHaveLength(1)
    expect(bridge.callsTo('receptionist.say')).toHaveLength(0)
    // Pressed, the bar is gone at once, before the server says what waits is read; back for something new.
    expect(screen.queryByRole('group', { name: 'Unread replies' })).toBeNull()
    act(() => useReceptionistStore.setState({ unread: { count: 1, first: 300 } }))
    expect(bar().getByRole('button', { name: 'Read aloud' })).toBeTruthy()
    expect(bar().getByRole('button', { name: 'Mark all read' })).toBeTruthy()

    // Gone while Control speaks, and back once it stops.
    act(() => useReceptionistStore.setState({ holder: { label: 'Phone', mine: true, muted: false }, mutedHere: false, phase: 'speaking' }))
    expect(screen.queryByRole('group', { name: 'Unread replies' })).toBeNull()
    act(() => useReceptionistStore.setState({ phase: 'ready' }))
    expect(bar().getByRole('button', { name: 'Read aloud' })).toBeTruthy()
    expect(bar().getByRole('button', { name: 'Mark all read' })).toBeTruthy()

    // Offered while it only thinks: the server stops that turn to read.
    act(() => useReceptionistStore.setState({ phase: 'thinking' }))
    expect(bar().getByRole('button', { name: 'Read aloud' })).toBeTruthy()
    expect(bar().getByRole('button', { name: 'Mark all read' })).toBeTruthy()
  })

  it('says why a reading was refused only until Control is done, or something plays', async () => {
    useReceptionistStore.setState({ phase: 'ready', unread: { count: 1, first: 0 } })
    render(<ControlTranscript variant="modal" onDismiss={() => {}} />)
    await screen.findByText('Nothing said to Control yet')
    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }))
    // The two crossed: Control began to speak as the button was pressed.
    act(() => useReceptionistStore.setState({ phase: 'speaking' }))
    act(() => bridge.emit.receptionistReplaying(null, 'Control is talking'))
    expect(screen.getByRole('alert').textContent).toBe('Could not play that: Control is talking.')
    act(() => useReceptionistStore.setState({ phase: 'ready' }))
    expect(screen.queryByRole('alert')).toBeNull()

    act(() => bridge.emit.receptionistReplaying(null, 'Control is talking'))
    expect(screen.getByRole('alert')).toBeTruthy()
    act(() => bridge.emit.receptionistReplaying({ of: 0, part: 0 }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('follows the voice only once the word being said nears the edge of the view', () => {
    const view = { top: 100, height: 400, scrollTop: 1000 }
    expect(followScroll(view, { top: 250, bottom: 270 })).toBeUndefined()
    // Below the band, or above it, the line goes a third of the way down.
    expect(followScroll(view, { top: 450, bottom: 470 })).toBeCloseTo(1000 + 350 - 400 / 3)
    expect(followScroll(view, { top: -2000, bottom: -1980 })).toBeCloseTo(0)
    expect(followScroll(view, { top: 80, bottom: 100 })).toBeCloseTo(1000 - 20 - 400 / 3)
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
    // A speaker's name marks nothing: it is no button at all without a node to go to.
    expect(screen.queryByRole('button', { name: 'Kevin' })).toBeNull()
    // Locked by the user's last message.
    expect(screen.getByText('Old news.').closest('.control-transcript__bubble--markable')).toBeNull()

    // Not while Control speaks: the voice says how far.
    act(() => useReceptionistStore.setState({ phase: 'speaking' }))
    expect(document.querySelector('.control-transcript__bubble--markable')).toBeNull()
    act(() => useReceptionistStore.setState({ phase: 'ready' }))
  })

  it("goes to the agent whose name heads what it said — its card, else the card holding its archive, else the root — and never for Control", async () => {
    const card = (id: string, archivedChildren: ArchivedNode[] = []) => ({ id, type: 'title', parentId: ROOT_NODE_ID, archivedChildren } as unknown as NodeData)
    const archived = (id: string): ArchivedNode => ({ archivedAt: at, data: card(id) })
    useNodeStore.setState({ nodes: { kevin: card('kevin'), host: card('host', [archived('sally')]) }, rootArchivedChildren: [] })
    bridge.responses.controlTranscript = () => ({
      entries: [{ offset: 0, timestamp: at, kind: 'reply', parts: [
        { from: 'Control', text: 'Three things.' },
        { from: 'Kevin', text: 'Green.', nodeId: asNodeId('kevin') },
        { from: 'Control', text: 'And' },
        { from: 'Sally', text: 'Shipped.', nodeId: asNodeId('sally') },
        { from: 'Control', text: 'And' },
        { from: 'Bob', text: 'Gone.', nodeId: asNodeId('bob') },
      ] }],
      more: false,
    })
    const onDismiss = vi.fn()
    render(<ControlTranscript variant="modal" onDismiss={onDismiss} />)
    await findBubble('Three things.')
    expect(screen.queryByRole('button', { name: /^Control/ })).toBeNull()
    const goes = (name: string) => {
      fireEvent.click(screen.getByRole('button', { name }))
      return useSurfacePresenterStore.getState().focusRequest?.nodeId
    }
    expect(goes('Kevin')).toBe('kevin')
    expect(goes('Sally')).toBe('host')
    expect(goes('Bob')).toBe(ROOT_NODE_ID)
    expect(onDismiss).toHaveBeenCalledTimes(3)
    expect(bridge.callsTo('receptionist.mark')).toHaveLength(0)
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


describe('holdActions', () => {
  it('takes Control muted for Text, so it never arrives speaking', () => {
    expect(holdActions('released', 'text')).toEqual(['mute', 'take'])
    expect(holdActions('speak', 'text')).toEqual(['mute'])
  })

  it('unmutes and takes at once for Speak, and lets go for Released', () => {
    expect(holdActions('released', 'speak')).toEqual(['speak-here'])
    expect(holdActions('text', 'speak')).toEqual(['speak-here'])
    expect(holdActions('text', 'released')).toEqual(['release'])
    expect(holdActions('speak', 'released')).toEqual(['release'])
  })

  it('asks nothing to stay where it is', () => {
    for (const mode of ['released', 'text', 'speak'] as const) expect(holdActions(mode, mode)).toEqual([])
  })
})
