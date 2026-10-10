import { describe, it, expect } from 'vitest'
import { redactUnheard } from './unheard'

describe('redactUnheard', () => {
  it('keeps the words that were said and marks the cut', () => {
    expect(redactUnheard('First sentence. Second sentence.', 31))
      .toBe('First sentence. Second *INTERRUPTED*')
  })

  // The offset Voice Operator reports is the end of the word its voice was on,
  // because it counts a word as heard the moment it starts. So that word is the
  // uncertain one and the marker takes its place — which also puts the marker
  // where the listener's attention was cut rather than a word past it.
  it('replaces the word the voice was cut off in', () => {
    expect(redactUnheard('One. Two. Three.', 9)).toBe('One. *INTERRUPTED*')
    expect(redactUnheard('First sentence. Second sentence.', 26))
      .toBe('First sentence. Second *INTERRUPTED*')
  })

  // Captured from a real interrupt: the listener stopped the voice during
  // "mango" and Voice Operator reported 92, the end of that word.
  it('drops the fruit the voice was in the middle of', () => {
    const list = 'Apple, banana, cherry, date, elderberry, fig, grape, honeydew, '
      + 'jackfruit, kiwi, lemon, mango, and nectarine.'
    expect(redactUnheard(list, 92)).toBe(
      'Apple, banana, cherry, date, elderberry, fig, grape, honeydew, '
      + 'jackfruit, kiwi, lemon, *INTERRUPTED*')
  })

  // A path is one thing to hear, not three. Cutting inside it would leave a
  // fragment the listener never heard as such and could not act on.
  it('treats a run of non-whitespace as one word', () => {
    expect(redactUnheard('Open src/main.ts now.', 12)).toBe('Open *INTERRUPTED*')
    expect(redactUnheard('Open src/main.ts now.', 16)).toBe('Open *INTERRUPTED*')
  })

  it('keeps nothing when not one word finished', () => {
    expect(redactUnheard('One. Two.', 0)).toBe('*INTERRUPTED*')
    expect(redactUnheard('One. Two.', 2)).toBe('*INTERRUPTED*')
  })

  it('leaves an answer heard to the end untouched', () => {
    expect(redactUnheard('One. Two.', 9)).toBe('One. Two.')
    expect(redactUnheard('One. Two.', 500)).toBe('One. Two.')
  })

  // A whole-sentence offset — an older Voice Operator, or a sentence that
  // finished before the interruption — points at the start of the next word
  // rather than just past the end of one. Nothing is dropped: the sentence it
  // completes was heard in full.
  it('leaves a sentence that finished before the cut intact', () => {
    expect(redactUnheard('First sentence. Second sentence.', 16))
      .toBe('First sentence. *INTERRUPTED*')
  })
})
