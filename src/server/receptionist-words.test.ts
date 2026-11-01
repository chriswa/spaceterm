import { describe, expect, it } from 'vitest'
import { dictatedText, routeHandsFreeWords, routeWords } from './receptionist-words'

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

describe('stop listening', () => {
  it('dismisses attention when said hands-free, with or without "Control", and only on its own', () => {
    expect(routeHandsFreeWords({ text: 'Stop listening.', triggered: false }, false)).toBe('stop-listening')
    expect(routeHandsFreeWords({ text: 'stop listening', triggered: true }, false)).toBe('stop-listening')
    expect(routeHandsFreeWords({ text: 'Stop listening to Kevin.', triggered: false }, false)).toBe('hear')
  })
})

describe('dictate', () => {
  it('keeps what follows "dictate" for the device, with or without "Control", but not once told to stop talking', () => {
    expect(routeHandsFreeWords({ text: 'Dictate, haha, that sounds great.', triggered: false }, false)).toBe('dictate')
    expect(routeHandsFreeWords({ text: 'dictate see you at six', triggered: true }, false)).toBe('dictate')
    expect(routeHandsFreeWords({ text: 'Dictate stop listening.', triggered: false }, false)).toBe('dictate')
    expect(routeHandsFreeWords({ text: 'Dictate, haha.', triggered: false }, true)).toBe('overheard')
    expect(routeHandsFreeWords({ text: 'Dictate, haha.', triggered: true }, true)).toBe('dictate')
  })

  it('only as the first word', () => {
    expect(routeHandsFreeWords({ text: 'Can you dictate a note?', triggered: false }, false)).toBe('hear')
    expect(routeHandsFreeWords({ text: 'Dictation is broken.', triggered: false }, false)).toBe('hear')
    expect(routeWords('Dictate, haha.')).toBe('hear')
  })

  it('takes the word and its punctuation off, and capitalises what is left', () => {
    expect(dictatedText('Dictate, haha, that sounds great.')).toBe('Haha, that sounds great.')
    expect(dictatedText('dictate: See you at six')).toBe('See you at six')
    expect(dictatedText('Dictate iPhone is charging.')).toBe('iPhone is charging.')
    expect(dictatedText('Dictate.')).toBe('')
    expect(dictatedText('Dictated it already.')).toBeUndefined()
  })
})
