import { describe, expect, it } from 'vitest'
import { cleanHandsFreeText } from './hands-free-words'

describe('cleanHandsFreeText', () => {
  it('takes the wake word off the front', () => {
    expect(cleanHandsFreeText('Control, what is Kevin doing?')).toBe('what is Kevin doing?')
    expect(cleanHandsFreeText('control what is Kevin doing')).toBe('what is Kevin doing')
    expect(cleanHandsFreeText('Control. Tell Evan to stop.')).toBe('Tell Evan to stop.')
    expect(cleanHandsFreeText('Computer, lights.', 'computer')).toBe('lights.')
  })

  it('leaves "control" alone anywhere but first, and is empty when nothing else was said', () => {
    expect(cleanHandsFreeText('Take control of the build.')).toBe('Take control of the build.')
    expect(cleanHandsFreeText('Control.')).toBe('')
  })
})
