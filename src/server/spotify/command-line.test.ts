import { describe, expect, it } from 'vitest'
import { parseWords, splitWords } from './command-line'

describe('splitWords', () => {
  it('splits on spaces and keeps quoted words whole', () => {
    expect(splitWords('  play --on "Kitchen speaker" ')).toEqual(['play', '--on', 'Kitchen speaker'])
    expect(splitWords('volume 40 --on="Chris\'s iPhone"')).toEqual(['volume', '40', "--on=Chris's iPhone"])
    expect(splitWords('')).toEqual([])
  })

  it('refuses a quote left open', () => {
    expect(() => splitWords('play --on "phone')).toThrow('quote is not closed')
  })
})

describe('parseWords', () => {
  it('reads positionals, --name value, --name=value, and the help flags', () => {
    const line = parseWords(['volume', '40', '--on', 'phone'])
    expect(line.positional).toEqual(['volume', '40'])
    expect(line.options.get('on')).toBe('phone')
    expect(parseWords(['play', '--on=mac']).options.get('on')).toBe('mac')
    expect(parseWords(['play', '--help', 'x']).options.get('help')).toBe(true)
    expect(parseWords(['play', '--help', 'x']).positional).toEqual(['play', 'x'])
    expect(parseWords(['-h']).options.get('help')).toBe(true)
  })

  it('says when an option is missing its value', () => {
    expect(() => parseWords(['play', '--on'])).toThrow('--on needs a value')
    expect(() => parseWords(['play', '--on', '--help'])).toThrow('--on needs a value')
  })
})
