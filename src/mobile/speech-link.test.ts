import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { speechLink, type SpeechSentence } from './speech-link'

vi.mock('./mobile-events', () => ({ recordMobileEvent: () => {} }))

/** The page's side of its speaker connection; Voice Operator's lines played by each test. */
function harness(connected = true) {
  const calls: string[] = []
  const lines: Array<Record<string, unknown>> = []
  let onLink: (message: { kind: 'line'; line: string } | { kind: 'closed' }) => void = () => {}
  let reconnect: () => void = () => {}
  let isConnected = connected
  const link = speechLink(
    {
      open: () => calls.push('open'),
      line: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
      close: () => calls.push('close'),
      onLink: (fn) => { onLink = fn; return () => {} },
    },
    () => 'phone-abc',
    { isConnected: () => isConnected, onConnect: (fn) => { reconnect = fn; return () => {} } },
    () => {},
  )
  return {
    link, calls, lines,
    voiceOperatorSays: (message: Record<string, unknown>) => onLink({ kind: 'line', line: JSON.stringify(message) }),
    closed: () => onLink({ kind: 'closed' }),
    reconnect: () => { isConnected = true; reconnect() },
    disconnect: () => { isConnected = false },
  }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('speechLink', () => {
  it('opens at once and says hello as this phone, a speaker', () => {
    const h = harness()
    expect(h.calls).toEqual(['open'])
    expect(h.lines).toEqual([{ type: 'hello', protocol: 1, client: 'spaceterm', role: 'speaker', device: 'phone-abc' }])
    h.link.dispose()
    expect(h.calls).toEqual(['open', 'close'])
  })

  it('waits for the server when not connected, and opens again on every reconnect', () => {
    const h = harness(false)
    expect(h.calls).toEqual([])
    h.reconnect()
    h.reconnect()
    expect(h.calls).toEqual(['open', 'open'])
    expect(h.lines).toHaveLength(2)
  })

  it('hands each sentence to the player, and its progress back to Voice Operator', () => {
    const h = harness()
    const heard: SpeechSentence[] = []
    h.link.onAudio((sentence) => heard.push(sentence))
    h.voiceOperatorSays({ type: 'sentence', id: 'ds_1', index: 0, count: 2, sampleRate: 24000, pcm: 'AAAA', sentAt: 5, synthMs: 100 })
    expect(heard).toEqual([{ id: 'ds_1', index: 0, count: 2, sampleRate: 24000, pcm: 'AAAA', sentAt: 5 }])
    h.link.progress('ds_1', 0, 'started')
    expect(h.lines.at(-1)).toEqual({ type: 'progress', id: 'ds_1', index: 0, event: 'started' })
  })

  it('stops a job Voice Operator ended early, not one that played out', () => {
    const h = harness()
    const stopped: string[] = []
    h.link.onStop((id) => stopped.push(id))
    h.voiceOperatorSays({ type: 'ended', id: 'ds_1', state: 'completed', characterOffset: 9 })
    h.voiceOperatorSays({ type: 'ended', id: 'ds_2', state: 'cancelled_by_client', characterOffset: 3 })
    expect(stopped).toEqual(['ds_2'])
  })

  it('opens again shortly after Voice Operator closes it, while the server is there', () => {
    const h = harness()
    h.closed()
    h.link.progress('ds_1', 0, 'finished')
    expect(h.lines).toHaveLength(1)
    vi.advanceTimersByTime(2000)
    expect(h.calls).toEqual(['open', 'open'])
    h.closed()
    h.disconnect()
    vi.advanceTimersByTime(2000)
    expect(h.calls).toEqual(['open', 'open'])
  })
})
