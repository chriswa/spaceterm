import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'events'
import { ServerPipe, type PipeSocket, type PipeTarget } from './server-pipe'

class FakeSocket extends EventEmitter {
  readonly written: string[] = []
  destroyed = false
  write(text: string): void { this.written.push(text) }
  destroy(): void { this.destroyed = true }
}

function harness() {
  const sent: Array<[string, string, string?]> = []
  const sockets: FakeSocket[] = []
  const target: PipeTarget = {
    send: (_channel, attempt, kind, chunk) => { sent.push(chunk === undefined ? [attempt, kind] : [attempt, kind, chunk]) },
    isDestroyed: () => false
  }
  const pipe = new ServerPipe(() => target, {
    connect: () => {
      const s = new FakeSocket()
      sockets.push(s)
      return s as unknown as PipeSocket
    }
  })
  return { pipe, sent, sockets }
}

describe('ServerPipe', () => {
  it('forwards open, data and close tagged with the attempt', () => {
    const h = harness()
    h.pipe.open('a1')
    h.sockets[0].emit('connect')
    h.sockets[0].emit('data', '{"type":"x"}\n')
    h.sockets[0].emit('close')
    expect(h.sent).toEqual([['a1', 'open'], ['a1', 'data', '{"type":"x"}\n'], ['a1', 'close']])
  })

  it('writes what the renderer sends to the current socket', () => {
    const h = harness()
    h.pipe.open('a1')
    h.pipe.send('hello\n')
    expect(h.sockets[0].written).toEqual(['hello\n'])
  })

  it('replaces the old socket on a new attempt, and the old one goes quiet', () => {
    // A reload opens a new attempt while the old socket may still be talking.
    const h = harness()
    h.pipe.open('a1')
    h.pipe.open('a2')
    expect(h.sockets[0].destroyed).toBe(true)

    h.sockets[0].emit('data', 'stale')
    h.sockets[0].emit('close')
    h.sockets[1].emit('connect')
    expect(h.sent).toEqual([['a2', 'open']])
  })

  it('stays silent when the renderer closes it', () => {
    const h = harness()
    h.pipe.open('a1')
    h.pipe.close()
    h.sockets[0].emit('close')
    expect(h.sent).toEqual([])
    h.pipe.send('nowhere')
    expect(h.sockets[0].written).toEqual([])
  })
})
