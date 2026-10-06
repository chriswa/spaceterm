import { describe, expect, it } from 'vitest'
import { MobileEventsLog } from './mobile-events'

function setup(written = '') {
  const lines: Record<string, unknown>[] = []
  const log = new MobileEventsLog({
    append: (text) => lines.push(...text.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)),
    now: () => new Date('2026-10-05T12:00:00Z'),
    readTail: () => written,
  })
  return { log, lines }
}

const event = (page: string, n: number, kind = 'visibility') => ({ t: '2026-10-05T11:59:59Z', page, n, kind, src: 'page' })

describe('MobileEventsLog', () => {
  it('appends one line per event, saying who sent it and when it arrived', () => {
    const { log, lines } = setup()
    log.write([event('a', 0), event('a', 1, 'mic-opened')], 'spaceterm-mobile 1234')
    expect(lines).toEqual([
      expect.objectContaining({ page: 'a', n: 0, kind: 'visibility', client: 'spaceterm-mobile 1234', receivedAt: '2026-10-05T12:00:00.000Z' }),
      expect.objectContaining({ page: 'a', n: 1, kind: 'mic-opened' }),
    ])
  })

  it('skips what a resent batch has already written, page load by page load', () => {
    const { log, lines } = setup()
    log.write([event('a', 0), event('a', 1)], 'c')
    log.write([event('a', 1), event('a', 2), event('b', 0)], 'c')
    expect(lines.map((l) => `${l.page}${l.n}`)).toEqual(['a0', 'a1', 'a2', 'b0'])
  })

  it('writes each of the app\'s events once, whichever page hands it over, across restarts too', () => {
    const native = (page: string, n: number, nativeSeq: number) => ({ ...event(page, n, 'app-background'), src: 'native', nativeSeq })
    const { log, lines } = setup('{"kind":"app-active","nativeSeq":5}\n')
    log.write([native('a', 0, 5), native('a', 1, 6)], 'c')
    // A new page, handed what the app still held.
    log.write([native('b', 0, 6), native('b', 1, 7)], 'c')
    expect(lines.map((l) => l.nativeSeq)).toEqual([6, 7])
  })

  it('writes what the server saw of the phone as lines of its own', () => {
    const { log, lines } = setup()
    log.server('client-disconnected', 'spaceterm-mobile 1234', { connectedForMs: 5000 })
    log.server('client-connected', 'spaceterm-mobile 5678')
    expect(lines).toEqual([
      expect.objectContaining({ kind: 'client-disconnected', src: 'server', n: 0, detail: { connectedForMs: 5000 } }),
      expect.objectContaining({ kind: 'client-connected', src: 'server', n: 1 }),
    ])
  })

  it('ignores what is not an event', () => {
    const { log, lines } = setup()
    log.write('nope', 'c')
    log.write([null, { kind: 'x' }, event('a', 0)], 'c')
    expect(lines).toHaveLength(1)
  })
})
