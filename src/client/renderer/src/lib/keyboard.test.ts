import { describe, it, expect, afterEach } from 'vitest'
import { isTextEditingSurface, shouldYieldToFocusedEditor, viewportSlotFor } from './keyboard'

// These predicates decide whether a global shortcut fires or the focused
// control keeps the keystroke. Too broad and Spaceterm steals characters out of
// someone's search box; too narrow and every shortcut stops working the moment
// a terminal has focus, which is where most of them are meant to work.

/** Build a detached element tree and return the innermost node. */
function element(html: string): Element {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.appendChild(host)
  return host.firstElementChild!
}

afterEach(() => { document.body.innerHTML = '' })

const key = (over: Partial<Pick<KeyboardEvent, 'key' | 'metaKey'>> = {}) =>
  ({ key: 'a', metaKey: false, ...over })

describe('isTextEditingSurface', () => {
  it('recognises an input', () => {
    expect(isTextEditingSurface(element('<input />'))).toBe(true)
  })

  it('recognises a textarea', () => {
    expect(isTextEditingSurface(element('<textarea></textarea>'))).toBe(true)
  })

  it('recognises a contenteditable region, which is how CodeMirror focuses', () => {
    const el = element('<div></div>') as HTMLElement
    // jsdom does not derive isContentEditable from the attribute.
    Object.defineProperty(el, 'isContentEditable', { value: true })
    expect(isTextEditingSurface(el)).toBe(true)
  })

  it('does NOT count xterm’s hidden textarea', () => {
    // xterm focuses a real <textarea> to receive input. Calling that an editor
    // disables every global shortcut whenever a terminal has focus — which is
    // where most of them are supposed to work.
    const el = element('<div class="xterm"><textarea></textarea></div>').querySelector('textarea')!
    expect(isTextEditingSurface(el)).toBe(false)
  })

  it('does not count an xterm textarea nested several levels deep', () => {
    const el = element('<div class="xterm"><div><div><textarea></textarea></div></div></div>')
      .querySelector('textarea')!
    expect(isTextEditingSurface(el)).toBe(false)
  })

  it('does not count an ordinary element', () => {
    expect(isTextEditingSurface(element('<div></div>'))).toBe(false)
  })

  it('does not count nothing focused', () => {
    expect(isTextEditingSurface(null)).toBe(false)
  })
})

describe('shouldYieldToFocusedEditor', () => {
  const input = () => element('<input />')
  const canvas = () => element('<div></div>')

  it('yields Escape, so the user is not trapped in the field', () => {
    expect(shouldYieldToFocusedEditor(input(), key({ key: 'Escape' }))).toBe(true)
  })

  it('yields Cmd+Arrow, which is word and line navigation', () => {
    for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      expect(shouldYieldToFocusedEditor(input(), key({ key: k, metaKey: true })), k).toBe(true)
    }
  })

  it('yields Cmd+Z, so a single keystroke does not undo the text AND the canvas', () => {
    expect(shouldYieldToFocusedEditor(input(), key({ key: 'z', metaKey: true }))).toBe(true)
  })

  it('does not yield a bare arrow — that is canvas navigation', () => {
    expect(shouldYieldToFocusedEditor(input(), key({ key: 'ArrowLeft' }))).toBe(false)
  })

  it('does not yield an ordinary key', () => {
    // A focused search box keeps its own characters through the browser's
    // default handling; this predicate is only about *global* bindings.
    expect(shouldYieldToFocusedEditor(input(), key({ key: 'k', metaKey: true }))).toBe(false)
  })

  it('never yields when nothing editable has focus', () => {
    expect(shouldYieldToFocusedEditor(canvas(), key({ key: 'Escape' }))).toBe(false)
    expect(shouldYieldToFocusedEditor(null, key({ key: 'Escape' }))).toBe(false)
  })

  it('never yields to a focused terminal, not even for Escape', () => {
    // Escape in a terminal belongs to the terminal via xterm's own handling,
    // not via this guard — and a Spaceterm binding on Escape must still fire.
    const term = element('<div class="xterm"><textarea></textarea></div>').querySelector('textarea')!
    expect(shouldYieldToFocusedEditor(term, key({ key: 'Escape' }))).toBe(false)
  })
})

describe('viewportSlotFor', () => {
  const chord = (over: Partial<Pick<KeyboardEvent, 'code' | 'metaKey' | 'shiftKey' | 'altKey'>>) =>
    ({ code: 'Digit1', metaKey: true, shiftKey: false, altKey: false, ...over })

  it('reads Cmd+digit as a restore', () => {
    expect(viewportSlotFor(chord({ code: 'Digit3' }))).toEqual({ slot: '3', action: 'restore' })
  })

  it('reads Cmd+Option+digit as a save', () => {
    expect(viewportSlotFor(chord({ code: 'Digit3', altKey: true }))).toEqual({ slot: '3', action: 'save' })
  })

  it('covers all ten slots including zero', () => {
    for (let i = 0; i <= 9; i++) {
      expect(viewportSlotFor(chord({ code: `Digit${i}` }))?.slot, `slot ${i}`).toBe(String(i))
    }
  })

  it('ignores Cmd+Shift+digit, which macOS reserves for screenshots', () => {
    // Cmd+Shift+3/4/5 are system screenshot shortcuts. Intercepting them would
    // be worse than not having the binding.
    expect(viewportSlotFor(chord({ code: 'Digit3', shiftKey: true }))).toBeNull()
    expect(viewportSlotFor(chord({ code: 'Digit4', shiftKey: true, altKey: true }))).toBeNull()
  })

  it('ignores a digit without Cmd', () => {
    expect(viewportSlotFor(chord({ metaKey: false }))).toBeNull()
  })

  it('ignores non-digit codes, including the numpad', () => {
    for (const code of ['KeyA', 'Numpad3', 'Digit', 'Digit10', 'Minus']) {
      expect(viewportSlotFor(chord({ code })), code).toBeNull()
    }
  })

  it('matches on code rather than key, which Option mangles on macOS', () => {
    // Option+3 produces '£' on a US layout; matching on `key` would lose the
    // save chord entirely while leaving restore working — a bug that presents
    // as "save silently does nothing".
    expect(viewportSlotFor({ code: 'Digit3', metaKey: true, shiftKey: false, altKey: true }))
      .toEqual({ slot: '3', action: 'save' })
  })
})
