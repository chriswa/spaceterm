import { describe, it, expect } from 'vitest'
import { VoiceOperator, joinSpeechParts, speechPartStarts } from './voice-operator'

/** A Voice Operator whose every request is recorded and accepted. */
function recording() {
  const bodies: unknown[] = []
  const vo = new VoiceOperator({
    readDiscovery: () => ({ port: 8123 }),
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ id: 'job-1', state: 'in_progress' }), { status: 202 })
    },
  })
  return { vo, bodies }
}

describe('VoiceOperator.speak', () => {
  it('sends plain text exactly as the single-voice API always has', async () => {
    const { vo, bodies } = recording()
    await vo.speak('Hello.', 'af_bella')
    await vo.speak('Hello.')
    expect(bodies).toEqual([{ text: 'Hello.', voice: 'af_bella' }, { text: 'Hello.' }])
  })

  it('sends parts, each unvoiced part taking the request voice', async () => {
    const { vo, bodies } = recording()
    await vo.speak([{ text: 'One.', voice: 'af_bella' }, { text: 'Two.' }], 'am_adam')
    await vo.speak([{ text: 'Three.' }])
    expect(bodies).toEqual([
      { parts: [{ text: 'One.', voice: 'af_bella' }, { text: 'Two.', voice: 'am_adam' }] },
      { parts: [{ text: 'Three.' }] },
    ])
  })
})

describe('joinSpeechParts', () => {
  it('joins with a single space, and passes plain text through', () => {
    expect(joinSpeechParts([{ text: 'One.' }, { text: 'Two.' }, { text: 'Three.' }])).toBe('One. Two. Three.')
    expect(joinSpeechParts('as is ')).toBe('as is ')
  })

  it('agrees with speechPartStarts, in UTF-16 units', () => {
    const parts = [{ text: '🙂 hi' }, { text: 'é' }, { text: 'end' }]
    const joined = joinSpeechParts(parts)
    speechPartStarts(parts).forEach((start, i) => {
      expect(joined.slice(start, start + parts[i].text.length)).toBe(parts[i].text)
    })
  })
})
