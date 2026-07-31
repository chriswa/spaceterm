import { describe, expect, it } from 'vitest'
import { TitleParser } from './title-parser'

/**
 * TitleParser scans the raw PTY stream for OSC 0/2 (window title) and OSC 7
 * (working directory). It is a byte-at-a-time state machine specifically so a
 * sequence split across two PTY chunks still parses — the chunk boundary is not
 * under our control.
 */
function collect(): { parser: TitleParser; titles: string[]; cwds: string[] } {
  const titles: string[] = []
  const cwds: string[] = []
  return { parser: new TitleParser((t) => titles.push(t), (c) => cwds.push(c)), titles, cwds }
}

describe('TitleParser', () => {
  it('parses an OSC 2 title terminated by BEL', () => {
    const { parser, titles } = collect()
    parser.write('\x1b]2;my title\x07')
    expect(titles).toEqual(['my title'])
  })

  it('parses an OSC 0 title', () => {
    const { parser, titles } = collect()
    parser.write('\x1b]0;zsh\x07')
    expect(titles).toEqual(['zsh'])
  })

  it('parses a title terminated by ST (ESC backslash)', () => {
    const { parser, titles } = collect()
    parser.write('\x1b]2;st terminated\x1b\\')
    expect(titles).toEqual(['st terminated'])
  })

  it('extracts the path from an OSC 7 cwd', () => {
    const { parser, cwds } = collect()
    parser.write('\x1b]7;file://host/Users/me/project\x07')
    expect(cwds).toEqual(['/Users/me/project'])
  })

  it('percent-decodes an OSC 7 path', () => {
    const { parser, cwds } = collect()
    parser.write('\x1b]7;file://host/Users/me/my%20dir\x07')
    expect(cwds).toEqual(['/Users/me/my dir'])
  })

  it('ignores a malformed OSC 7 payload', () => {
    const { parser, cwds } = collect()
    parser.write('\x1b]7;not a url\x07')
    expect(cwds).toEqual([])
  })

  it('passes ordinary text through without emitting', () => {
    const { parser, titles, cwds } = collect()
    parser.write('just some output\nwith newlines\n')
    expect(titles).toEqual([])
    expect(cwds).toEqual([])
  })

  it('ignores OSC codes it does not handle', () => {
    const { parser, titles, cwds } = collect()
    parser.write('\x1b]8;;https://example.com\x07link\x1b]8;;\x07')
    expect(titles).toEqual([])
    expect(cwds).toEqual([])
  })

  it('ignores a non-OSC escape sequence', () => {
    const { parser, titles } = collect()
    parser.write('\x1b[31mred\x1b[0m')
    expect(titles).toEqual([])
  })

  it('parses a title split across two chunks mid-payload', () => {
    const { parser, titles } = collect()
    parser.write('\x1b]2;split ')
    expect(titles).toEqual([])
    parser.write('title\x07')
    expect(titles).toEqual(['split title'])
  })

  it('parses a title split immediately after the escape byte', () => {
    const { parser, titles } = collect()
    parser.write('\x1b')
    parser.write(']2;after esc\x07')
    expect(titles).toEqual(['after esc'])
  })

  it('parses a title split between the code and the semicolon', () => {
    const { parser, titles } = collect()
    parser.write('\x1b]2')
    parser.write(';split code\x07')
    expect(titles).toEqual(['split code'])
  })

  it('parses a byte-at-a-time stream', () => {
    const { parser, titles } = collect()
    for (const ch of '\x1b]2;one byte at a time\x07') parser.write(ch)
    expect(titles).toEqual(['one byte at a time'])
  })

  it('emits several titles from one chunk', () => {
    const { parser, titles } = collect()
    parser.write('\x1b]2;first\x07some output\x1b]2;second\x07')
    expect(titles).toEqual(['first', 'second'])
  })

  it('strips a leading non-printable prefix from a title', () => {
    const { parser, titles } = collect()
    parser.write('\x1b]2;\x01\x02 real title\x07')
    expect(titles).toEqual(['real title'])
  })

  it('does not emit an empty title', () => {
    const { parser, titles } = collect()
    parser.write('\x1b]2;\x07')
    expect(titles).toEqual([])
  })

  it('trims surrounding whitespace', () => {
    const { parser, titles } = collect()
    parser.write('\x1b]2;   padded   \x07')
    expect(titles).toEqual(['padded'])
  })

  it('recovers after an aborted OSC and parses the next one', () => {
    const { parser, titles } = collect()
    // An ESC that is not ST aborts the payload; the following OSC must still parse.
    parser.write('\x1b]2;aborted\x1b[0m\x1b]2;recovered\x07')
    expect(titles).toEqual(['recovered'])
  })

  // The ST terminator is two bytes (ESC \), so a chunk can end between them.
  // This used to append the ESC to the payload, which both corrupted the title
  // and left the parser stuck in CollectPayload so it never emitted.
  it('parses a title whose ST terminator is split across chunks', () => {
    const { parser, titles } = collect()
    parser.write('\x1b]2;split st\x1b')
    expect(titles).toEqual([])
    parser.write('\\')
    expect(titles).toEqual(['split st'])
  })

  it('parses an OSC 7 cwd whose ST terminator is split across chunks', () => {
    const { parser, cwds } = collect()
    parser.write('\x1b]7;file://host/tmp/x\x1b')
    parser.write('\\')
    expect(cwds).toEqual(['/tmp/x'])
  })

  it('recovers when the byte after a chunk-boundary ESC is not ST', () => {
    const { parser, titles } = collect()
    parser.write('\x1b]2;aborted\x1b')
    // '[' means the held ESC began a CSI, not ST — the OSC is abandoned.
    parser.write('[0m\x1b]2;recovered\x07')
    expect(titles).toEqual(['recovered'])
  })

  it('starts a new OSC when a chunk-boundary ESC is followed by one', () => {
    const { parser, titles } = collect()
    parser.write('\x1b]2;abandoned\x1b')
    parser.write(']2;next\x07')
    expect(titles).toEqual(['next'])
  })

  it('does not leak a held ESC into the next title', () => {
    const { parser, titles } = collect()
    parser.write('\x1b]2;first\x1b')
    parser.write('\\')
    parser.write('\x1b]2;second\x07')
    expect(titles).toEqual(['first', 'second'])
  })

  it('resets the buffer between titles', () => {
    const { parser, titles } = collect()
    parser.write('\x1b]2;first\x07')
    parser.write('\x1b]2;second\x07')
    expect(titles).toEqual(['first', 'second'])
  })
})
