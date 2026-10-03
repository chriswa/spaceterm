import { describe, expect, it } from 'vitest'
import { CONTROL, isBlocking, parseReply, redactSpoken, renderSpeech, type Speaker } from './reply'

const KEVIN: Speaker = { name: 'Kevin', voice: 'am_michael' }
const resolveKevin = (handle: string): Speaker | undefined => handle === 'a1' ? KEVIN : undefined

describe('parseReply', () => {
  it('reads parts and tools', () => {
    const reply = parseReply('{"say":[{"from":"control","text":"Checking."}],"tools":[{"tool":"read","agent":"a1","search":"bananas"}]}')
    expect(reply.say).toEqual([{ from: CONTROL, text: 'Checking.' }])
    expect(reply.tools).toEqual([{ tool: 'read', agent: 'a1', search: 'bananas' }])
  })

  it('tolerates a code fence or preamble around the object', () => {
    expect(parseReply('Sure:\n```json\n{"say":[{"text":"Hi."}]}\n```').say).toEqual([{ from: CONTROL, text: 'Hi.' }])
  })

  it('treats missing say and tools as empty, and drops blank parts', () => {
    expect(parseReply('{"say":[{"from":"control","text":"  "}]}')).toEqual({ say: [], tools: [] })
  })

  it('rejects what it cannot use, with a reason', () => {
    expect(() => parseReply('no json here')).toThrow(/JSON object/)
    expect(() => parseReply('{"tools":[{"tool":"launch","agent":"a1"}]}')).toThrow(/unknown tool/)
    expect(() => parseReply('{"tools":[{"tool":"ask_fork","agent":"a1"}]}')).toThrow(/question/)
    expect(() => parseReply('{"tools":[{"tool":"read"}]}')).toThrow(/agent/)
  })

  it('only read blocks the turn', () => {
    expect(isBlocking({ tool: 'read', agent: 'a1' })).toBe(true)
    expect(isBlocking({ tool: 'monitor', agent: 'a1' })).toBe(false)
    expect(isBlocking({ tool: 'ask_fork', agent: 'a1', question: 'q' })).toBe(false)
  })
})

describe('renderSpeech', () => {
  it('names placeholders and introduces an agent in its own voice', () => {
    const parts = renderSpeech([
      { from: CONTROL, text: '{a1} is on the water simulation.' },
      { from: 'a1', text: 'The solver is done.' },
    ], resolveKevin, 'af_heart')
    expect(parts).toEqual([
      { text: 'Kevin is on the water simulation.', voice: 'af_heart', introLength: 0 },
      { text: 'Kevin here. The solver is done.', voice: 'am_michael', introLength: 'Kevin here. '.length },
    ])
  })

  it('never lends an agent voice to a part from an unknown handle', () => {
    const [part] = renderSpeech([{ from: 'zz', text: 'Hello.' }], resolveKevin, 'af_heart')
    expect(part.voice).toBe('af_heart')
    expect(part.text).toBe('Hello.')
  })

  it('speaks an unresolvable placeholder as "an agent", not as its handle', () => {
    const [part] = renderSpeech([{ from: CONTROL, text: '{zz} stopped.' }], resolveKevin, 'af_heart')
    expect(part.text).toBe('an agent stopped.')
  })
})

describe('redactSpoken', () => {
  const parts = [
    { text: 'Kevin is done.', voice: 'af_heart', introLength: 0 },
    { text: 'Kevin here. The solver works now.', voice: 'am_michael', introLength: 12 },
  ]

  it('keeps everything when all of it was heard', () => {
    expect(redactSpoken(parts, 1_000)).toEqual(parts)
  })

  it('offsets into the single-space join, cutting inside the second part', () => {
    const intoSecond = parts[0].text.length + 1 + 'Kevin here. The sol'.length
    const kept = redactSpoken(parts, intoSecond)
    expect(kept).toHaveLength(2)
    expect(kept[0]).toEqual(parts[0])
    expect(kept[1].text).toBe('Kevin here. The *INTERRUPTED*')
  })

  it('drops parts after the cut entirely', () => {
    const kept = redactSpoken(parts, 6)
    expect(kept).toHaveLength(1)
    expect(kept[0].text).toMatch(/INTERRUPTED/)
  })
})
