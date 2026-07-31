import { describe, expect, it } from 'vitest'
import { LineParser } from './line-parser'

/**
 * LineParser splits a socket stream into newline-delimited JSON messages. It is
 * fed by four sockets (the client, hooks and scripts servers, and the main
 * process's ServerClient), all of which call setEncoding('utf8') — but it also
 * accepts Buffers, so a caller that forgets cannot silently corrupt messages.
 */
function collect(): { parser: LineParser; messages: unknown[] } {
  const messages: unknown[] = []
  return { parser: new LineParser((m) => messages.push(m)), messages }
}

describe('LineParser', () => {
  it('parses a single complete line', () => {
    const { parser, messages } = collect()
    parser.feed('{"type":"a"}\n')
    expect(messages).toEqual([{ type: 'a' }])
  })

  it('parses several lines in one chunk', () => {
    const { parser, messages } = collect()
    parser.feed('{"n":1}\n{"n":2}\n{"n":3}\n')
    expect(messages).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
  })

  it('buffers a partial line until its newline arrives', () => {
    const { parser, messages } = collect()
    parser.feed('{"type":')
    expect(messages).toEqual([])
    parser.feed('"a"}\n')
    expect(messages).toEqual([{ type: 'a' }])
  })

  it('handles a message split across many chunks', () => {
    const { parser, messages } = collect()
    for (const ch of '{"type":"split"}') parser.feed(ch)
    expect(messages).toEqual([])
    parser.feed('\n')
    expect(messages).toEqual([{ type: 'split' }])
  })

  it('emits a completed line and holds the partial that follows it', () => {
    const { parser, messages } = collect()
    parser.feed('{"n":1}\n{"n":')
    expect(messages).toEqual([{ n: 1 }])
    parser.feed('2}\n')
    expect(messages).toEqual([{ n: 1 }, { n: 2 }])
  })

  it('ignores blank lines', () => {
    const { parser, messages } = collect()
    parser.feed('\n\n{"n":1}\n\n')
    expect(messages).toEqual([{ n: 1 }])
  })

  it('skips a malformed line without dropping the ones around it', () => {
    const { parser, messages } = collect()
    parser.feed('{"n":1}\nnot json\n{"n":2}\n')
    expect(messages).toEqual([{ n: 1 }, { n: 2 }])
  })

  it('accepts a Buffer chunk', () => {
    const { parser, messages } = collect()
    parser.feed(Buffer.from('{"n":1}\n', 'utf8'))
    expect(messages).toEqual([{ n: 1 }])
  })

  it('joins a multi-byte character split across two Buffer chunks', () => {
    // The reason feed() keeps a StringDecoder rather than calling toString() per
    // chunk: a naive decode would turn each half into a replacement character
    // and produce invalid JSON.
    const { parser, messages } = collect()
    const full = Buffer.from('{"s":"héllo→"}\n', 'utf8')
    const cut = 10 // lands inside the multi-byte sequence
    parser.feed(full.subarray(0, cut))
    parser.feed(full.subarray(cut))
    expect(messages).toEqual([{ s: 'héllo→' }])
  })

  it('interleaves string and Buffer chunks', () => {
    const { parser, messages } = collect()
    parser.feed('{"n":')
    parser.feed(Buffer.from('1}\n', 'utf8'))
    expect(messages).toEqual([{ n: 1 }])
  })

  it('preserves message order', () => {
    const { parser, messages } = collect()
    parser.feed('{"i":0}\n{"i":1}\n')
    parser.feed('{"i":2}\n')
    expect(messages).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }])
  })
})
