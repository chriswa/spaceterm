import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ALARM_LIMIT, AttentionKeeper, type AttentionMessage } from './hands-free-attention'

describe('AttentionKeeper', () => {
  let sent: AttentionMessage[]
  let keeper: AttentionKeeper
  const states = () => sent.map((m) => m.state)

  beforeEach(() => {
    vi.useFakeTimers()
    sent = []
    keeper = new AttentionKeeper((m) => sent.push(m))
  })
  afterEach(() => { vi.useRealTimers() })

  it('holds engaged attention while anyone speaks, and lets it lapse after quiet', () => {
    keeper.engagedMs = 30_000
    keeper.engage()
    expect(sent.at(-1)).toEqual({ type: 'attention', state: 'engaged', closesAt: null })
    keeper.see(true)
    expect(sent.at(-1)?.closesAt).toBe(Date.now() + 30_000)
    vi.advanceTimersByTime(20_000)
    keeper.see(false)
    expect(sent.at(-1)).toEqual({ type: 'attention', state: 'engaged', closesAt: null })
    vi.advanceTimersByTime(60_000)
    expect(keeper.attention).toBe('engaged')
    keeper.see(true)
    vi.advanceTimersByTime(29_999)
    expect(keeper.attention).toBe('engaged')
    vi.advanceTimersByTime(1)
    expect(keeper.attention).toBe('lapsed')
    expect(sent.at(-1)).toEqual({ type: 'attention', state: 'lapsed', closesAt: null })
  })

  it('stops the alarm once it has sounded enough, dismissing attention', () => {
    keeper.see(true)
    keeper.engage()
    vi.advanceTimersByTime(15_000)
    for (let i = 1; i < ALARM_LIMIT; i++) keeper.alarmed()
    expect(keeper.attention).toBe('lapsed')
    keeper.alarmed()
    expect(states().at(-1)).toBe('dismissed')
  })

  it('counts alarms afresh each time attention lapses', () => {
    keeper.see(true)
    keeper.engage()
    vi.advanceTimersByTime(15_000)
    keeper.alarmed()
    keeper.alarmed()
    keeper.engage()
    vi.advanceTimersByTime(15_000)
    keeper.alarmed()
    expect(keeper.attention).toBe('lapsed')
  })

  it('dismissed by the user, no timer runs and no alarm counts', () => {
    keeper.see(true)
    keeper.engage()
    keeper.dismiss()
    vi.advanceTimersByTime(60_000)
    expect(states()).toEqual(['engaged', 'dismissed'])
    keeper.alarmed()
    expect(states()).toEqual(['engaged', 'dismissed'])
  })

  it('says it again on request, as it stands', () => {
    keeper.restate()
    expect(states()).toEqual(['lapsed'])
    keeper.dismiss()
    keeper.restate()
    expect(states()).toEqual(['lapsed', 'dismissed', 'dismissed'])
  })
})
