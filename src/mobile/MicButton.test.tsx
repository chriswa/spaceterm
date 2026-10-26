import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react'
import { installFakeBridge, type FakeBridge } from '@/testing/fake-bridge'
import { useReceptionistStore } from '@/stores/receptionistStore'
import { useControlTranscriptStore } from '@/stores/controlTranscriptStore'
import { holdState, setHoldMicrophone } from './held-microphone'
import { useDictationSession } from './dictation-session'
import * as cues from './cues'
import { MicButton } from './MicButton'
import { HandsFreeButton } from './HandsFreeButton'
import { useHandsFree } from './hands-free'

let bridge: FakeBridge

beforeEach(() => {
  bridge = installFakeBridge()
  useReceptionistStore.setState({ phase: 'ready', error: null, holder: null })
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  setHoldMicrophone(false)
  useDictationSession.setState({ mic: { kind: 'idle' } })
  useHandsFree.setState({ phase: 'off', mini: null })
})

const mic = () => screen.getByRole('button', { name: /Talk to|Cut .* off|dictating/ })

describe('the hands-free button', () => {
  it('switches hands-free on with a tap, and off with the next, leaving the microphone a plain tap', () => {
    render(<><MicButton /><HandsFreeButton /></>)
    const lock = screen.getByRole('button', { name: /[Aa]lways listen|Hold the microphone open/ })
    expect(lock.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(lock)
    expect(holdState()).not.toBe('off')
    expect(lock.getAttribute('aria-pressed')).toBe('true')
    expect(lock.getAttribute('aria-label')).toMatch(/tap to stop/)
    expect(bridge.callsTo('dictation.start')).toHaveLength(0)

    fireEvent.click(lock)
    expect(holdState()).toBe('off')
  })
})

describe('the microphone and Control', () => {
  it('talks to Control', () => {
    render(<MicButton />)
    expect(screen.getByRole('button', { name: /^Talk to Control/ })).toBeTruthy()
  })

  it('never shows what Control is doing, yet a tap still cuts Control off', () => {
    useReceptionistStore.setState({ phase: 'speaking' })
    const { container } = render(<MicButton />)
    expect(container.querySelector('.m-mic--off')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Cut Control off and talk/ }))
    // Stopped, not let go of: letting go would silence it.
    expect(bridge.callsTo('receptionist.stop')).toHaveLength(1)
    expect(bridge.callsTo('receptionist.hold')).toHaveLength(0)
  })
})

describe('the microphone over Control’s transcript', () => {
  it('sends what it hears straight to Control, and shows it at the bottom of the transcript', async () => {
    act(() => useControlTranscriptStore.getState().setOpen(true))
    const finish = vi.fn(async () => 'what is Kevin doing?')
    const dictation = await import('./dictation')
    vi.spyOn(dictation.Dictation, 'begin').mockReturnValue({} as never)
    vi.spyOn(dictation, 'whenHearing').mockResolvedValue({ finish, cancel: vi.fn() } as never)
    const { container } = render(<MicButton />)
    fireEvent.click(screen.getByRole('button', { name: /^Talk to Control/ }))
    await screen.findByRole('button', { name: 'Listening — tap to send' })
    expect(container.querySelector('.m-mic--hearing')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Listening — tap to send' }))
    await screen.findByRole('button', { name: /^Talk to Control/ })
    expect(bridge.lastCall('receptionist.say')).toEqual(['what is Kevin doing?', { staysPut: true }])
    expect(useControlTranscriptStore.getState().pending).toEqual(['what is Kevin doing?'])
    act(() => useControlTranscriptStore.getState().setOpen(false))
    vi.restoreAllMocks()
  })
})

describe('the microphone and who holds Control', () => {
  async function speak(): Promise<void> {
    const dictation = await import('./dictation')
    vi.spyOn(dictation.Dictation, 'begin').mockReturnValue({} as never)
    vi.spyOn(dictation, 'whenHearing').mockResolvedValue({ finish: vi.fn(async () => 'hello'), cancel: vi.fn() } as never)
    render(<MicButton />)
    fireEvent.click(screen.getByRole('button', { name: /^Talk to Control/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Listening — tap to send' }))
    await screen.findByRole('button', { name: /^Talk to Control/ })
  }

  afterEach(() => vi.restoreAllMocks())

  it('leaves Control where it is, and with nobody holding it plays the jingle: taken, but no reply is coming', async () => {
    const jingle = vi.spyOn(cues, 'playHeardUnattachedCue').mockImplementation(() => undefined)
    await speak()
    expect(bridge.lastCall('receptionist.say')).toEqual(['hello', { staysPut: true }])
    expect(jingle).toHaveBeenCalledTimes(1)
  })

  it('plays no jingle when Control is held, here or elsewhere', async () => {
    const jingle = vi.spyOn(cues, 'playHeardUnattachedCue').mockImplementation(() => undefined)
    useReceptionistStore.setState({ holder: { label: 'Mac', mine: false, muted: false } })
    await speak()
    expect(jingle).not.toHaveBeenCalled()
  })
})

describe('a composer’s dictation still running', () => {
  it('turns the microphone orange, and a tap goes back to a composer instead of talking', () => {
    useDictationSession.setState({ mic: { kind: 'listening', dictation: {} as never } })
    const reopen = vi.fn()
    const { container } = render(<MicButton onReopenComposer={reopen} />)
    expect(container.querySelector('.m-mic--hearing')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /tap to open the composer/ }))
    expect(reopen).toHaveBeenCalledTimes(1)
    expect(bridge.callsTo('dictation.start')).toHaveLength(0)
  })

  it('with nowhere to reopen it, only says so', () => {
    useDictationSession.setState({ mic: { kind: 'listening', dictation: {} as never } })
    render(<MicButton />)
    fireEvent.click(screen.getByRole('button', { name: /open a composer to stop or ship it/ }))
    expect(bridge.callsTo('dictation.start')).toHaveLength(0)
  })
})

describe('a tap, from press to sound', () => {
  afterEach(() => vi.restoreAllMocks())

  it('shows the microphone connecting at once, not orange until sound arrives, and a second tap gives up', async () => {
    const dictation = await import('./dictation')
    vi.spyOn(dictation.Dictation, 'begin').mockReturnValue(new Promise(() => {}) as never)
    vi.spyOn(dictation, 'whenHearing').mockReturnValue(new Promise(() => {}) as never)
    const { container } = render(<MicButton />)
    fireEvent.click(screen.getByRole('button', { name: /^Talk to Control/ }))
    expect(container.querySelector('.m-mic--connecting')).not.toBeNull()
    expect(container.querySelector('.m-mic--hearing')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Starting the microphone.*tap to give up/ }))
    expect(container.querySelector('.m-mic--off')).not.toBeNull()
  })

  it('shows a failure in red until a tap, which tries again', async () => {
    const dictation = await import('./dictation')
    vi.spyOn(dictation.Dictation, 'begin').mockReturnValue({} as never)
    const hearing = vi.spyOn(dictation, 'whenHearing').mockRejectedValueOnce(new Error("The app's microphone did not start"))
    hearing.mockReturnValue(new Promise(() => {}) as never)
    const { container } = render(<MicButton />)
    fireEvent.click(screen.getByRole('button', { name: /^Talk to Control/ }))
    await screen.findByRole('alert')
    expect(container.querySelector('.m-mic--error')).not.toBeNull()
    expect(screen.getByRole('alert').textContent).toMatch(/did not start/)
    expect(container.contains(screen.getByRole('alert'))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /Failed — tap to try again/ }))
    expect(container.querySelector('.m-mic--connecting')).not.toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('what may end a hands-free dictation', () => {
  const gauge = (container: HTMLElement, which: 'mini' | 'quiet') =>
    container.querySelector<SVGElement>(`.m-hands-free__gauge--${which}`)

  it('shows turn-1-mini on the left half of the hands-free button, not on the microphone, and the quiet on the right', () => {
    useHandsFree.setState({ phase: 'hearing', mini: null })
    const { container } = render(<><MicButton /><HandsFreeButton /></>)
    expect(container.querySelector('.m-mic__turn')).toBeNull()
    expect(gauge(container, 'mini')?.style.clipPath).toBe('inset(100.0% 0 0 0)')
    expect(gauge(container, 'mini')?.querySelector('rect')?.getAttribute('width')).toBe('21')
    expect(gauge(container, 'quiet')?.querySelector('rect')?.getAttribute('x')).toBe('21')
    // From 0 to 1, the answer itself, not its share of the threshold.
    act(() => useHandsFree.setState({ mini: { p: 0.6, peak: 0.6, threshold: 0.5 } }))
    expect(gauge(container, 'mini')?.style.clipPath).toBe('inset(40.0% 0 0 0)')
    expect(container.querySelector('.m-hands-free__gauge--turn')).toBeNull()
  })

  it('shows turn-1-mini on the left half: its latest answer, its threshold, and its peak since the pause began', () => {
    // While they talk: nothing, as the quiet.
    useHandsFree.setState({ phase: 'hearing', mini: { p: 0.1, peak: null, threshold: 0.17 } })
    const { container } = render(<HandsFreeButton />)
    expect(gauge(container, 'mini')?.style.clipPath).toBe('inset(100.0% 0 0 0)')
    expect(container.querySelector('.m-hands-free__threshold')).toBeNull()
    expect(container.querySelector('.m-hands-free__peak')).toBeNull()
    // In a pause: its latest answer, its threshold, and its peak.
    act(() => useHandsFree.setState({ mini: { p: 0.1, peak: 0.4, threshold: 0.17 } }))
    expect(gauge(container, 'mini')?.style.clipPath).toBe('inset(90.0% 0 0 0)')
    const [threshold] = container.querySelectorAll('.m-hands-free__threshold')
    expect(Number(threshold.getAttribute('x2'))).toBeCloseTo(21)
    expect(Number(threshold.getAttribute('y1'))).toBeCloseTo(42 * 0.83)
    expect(Number(container.querySelector('.m-hands-free__peak')?.getAttribute('y1'))).toBeCloseTo(42 * 0.6)
    // They carry on: all of it clears.
    act(() => useHandsFree.setState({ mini: { p: 0.02, peak: null, threshold: 0.17 } }))
    expect(container.querySelector('.m-hands-free__threshold')).toBeNull()
    expect(container.querySelector('.m-hands-free__peak')).toBeNull()
  })

  it('keeps both up while what was said is sent, and drops them once it is listening again', () => {
    useHandsFree.setState({ phase: 'sending', mini: { p: 0.6, peak: 0.6, threshold: 0.5 } })
    const { container } = render(<HandsFreeButton />)
    expect(gauge(container, 'mini')).not.toBeNull()
    expect(gauge(container, 'quiet')).not.toBeNull()
    act(() => useHandsFree.setState({ phase: 'listening', mini: null }))
    expect(gauge(container, 'mini')).toBeNull()
    expect(gauge(container, 'quiet')).toBeNull()
  })
})
