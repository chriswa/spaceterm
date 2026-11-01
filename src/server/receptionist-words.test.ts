import { describe, expect, it } from 'vitest'
import { routeHandsFreeWords, routeWords } from './receptionist-words'

describe('routeWords', () => {
  it('takes the fixed phrases without the model, and gives it everything else', () => {
    expect(routeWords('')).toBe('nothing')
    expect(routeWords('Let me turn this off.')).toBe('away')
    expect(routeWords('Control, shutdown.')).toBe('away')
    for (const text of ['Stop talking.', 'Stop conversation.', 'End conversation.']) expect(routeWords(text), text).toBe('stop-talking')
    expect(routeWords('What is Kevin doing?')).toBe('hear')
  })
})

describe('routeHandsFreeWords', () => {
  it('hears words in the conversation window, without "Control", as usual', () => {
    expect(routeHandsFreeWords({ text: 'And the tests?', triggered: false }, false)).toBe('hear')
    expect(routeHandsFreeWords({ text: 'Stop talking.', triggered: false }, false)).toBe('stop-talking')
  })

  it('once told to stop talking, ignores whatever is said without "Control", whatever it is', () => {
    for (const text of ['And the tests?', 'Stop talking.', 'Let me turn this off.', '']) {
      expect(routeHandsFreeWords({ text, triggered: false }, true), text).toBe('overheard')
    }
  })

  it('once told to stop talking, hears "Control" again', () => {
    expect(routeHandsFreeWords({ text: 'what is Kevin doing?', triggered: true }, true)).toBe('hear')
    expect(routeHandsFreeWords({ text: '', triggered: true }, true)).toBe('nothing')
    expect(routeHandsFreeWords({ text: 'stop talking', triggered: true }, true)).toBe('stop-talking')
  })
})
