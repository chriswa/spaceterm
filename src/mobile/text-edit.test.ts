import { describe, it, expect } from 'vitest'
import { deleteWordBefore } from './text-edit'

describe('deleteWordBefore', () => {
  it('takes the last word', () => {
    expect(deleteWordBefore('fix the flaky test', 18)).toEqual({ text: 'fix the flaky ', cursor: 14 })
  })

  it('takes the space before the cursor along with the word before it', () => {
    expect(deleteWordBefore('fix the flaky ', 14)).toEqual({ text: 'fix the ', cursor: 8 })
  })

  it('works from the middle, leaving what follows the cursor', () => {
    expect(deleteWordBefore('fix the flaky test', 13)).toEqual({ text: 'fix the  test', cursor: 8 })
  })

  it('treats punctuation as part of the word, as readline does', () => {
    expect(deleteWordBefore('run it now.', 11)).toEqual({ text: 'run it ', cursor: 7 })
  })

  it('does nothing at the start', () => {
    expect(deleteWordBefore('abc', 0)).toEqual({ text: 'abc', cursor: 0 })
  })
})
