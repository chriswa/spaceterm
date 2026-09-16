/**
 * Deciding what a keystroke means, separately from doing it.
 *
 * `App.tsx`'s global keydown handler is 380 lines of condition-then-effect. The
 * effects need App's state and cannot leave; the *conditions* are pure
 * functions of a keyboard event and the focused element, and they are where
 * the subtle mistakes live — a guard that is slightly too broad steals
 * keystrokes out of the user's text input, and one slightly too narrow means a
 * shortcut silently stops working in terminals.
 *
 * Those conditions live here, with tests.
 */

import type { SummaryChatMode } from '../../../../shared/api'

/**
 * Keys that must reach a focused text-editing control even though Spaceterm
 * binds them globally.
 *
 * - `Escape` exits the control. Swallowing it traps the user in the field.
 * - `Cmd+Arrow` is word/line navigation, which no global binding should
 *   override while someone is editing text.
 * - `Cmd+Z` is native undo. Spaceterm has its own undo, and running both on
 *   one keystroke would undo the canvas *and* the text.
 */
function isEditorReservedKey(event: Pick<KeyboardEvent, 'key' | 'metaKey'>): boolean {
  if (event.key === 'Escape') return true
  return event.metaKey && (event.key.startsWith('Arrow') || event.key === 'z')
}

/**
 * True when `active` is a real text-editing surface — an input, a textarea, or
 * a contenteditable region such as CodeMirror.
 *
 * xterm is deliberately excluded. It focuses a hidden `<textarea>` to receive
 * input, so a naive tag check calls every focused terminal an editor and
 * disables every global shortcut on the canvas. The terminal is where most of
 * these shortcuts are *meant* to work.
 */
export function isTextEditingSurface(active: Element | null): boolean {
  if (!active) return false
  if (active.closest('.xterm')) return false
  const el = active as HTMLElement
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true
}

/**
 * True when a global shortcut must stand aside and let the focused control have
 * this keystroke.
 *
 * Only reserved keys are yielded, not every key: a focused search input still
 * receives Cmd+K to close itself, which is why the caller checks the modal
 * shortcuts *before* consulting this.
 */
export function shouldYieldToFocusedEditor(
  active: Element | null,
  event: Pick<KeyboardEvent, 'key' | 'metaKey'>
): boolean {
  return isTextEditingSurface(active) && isEditorReservedKey(event)
}

/**
 * Which Summary Chat mode this keystroke asks for, or null if it is not the
 * chord at all.
 *
 * Cmd+Ctrl+X summarizes; adding Shift reads the agent's final message out
 * word for word. One function rather than two predicates, because the two
 * chords differ by a single modifier and separate tests for them could both
 * match — or, as easily, neither.
 *
 * Control is required, not optional as it was for the old Cmd+P chord: bare
 * Cmd+X is Cut, and a global binding that swallowed it would break cutting text
 * everywhere in the app.
 *
 * `key` is lowercased before comparison. With Shift held macOS reports `'X'`,
 * so a bare `=== 'x'` test decides the mode by accident and drops the Verbatim
 * chord entirely; Shift is read from `shiftKey`, which says what was actually
 * held.
 *
 * Autorepeat is excluded rather than left to the caller. The chord is a toggle,
 * so a held key would start an answer, cancel it, start another, and so on for
 * as long as the finger stays down.
 */
export function summaryChatChordFor(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'repeat'>
): SummaryChatMode | null {
  if (!event.metaKey || !event.ctrlKey || event.repeat) return null
  if (event.key.toLowerCase() !== 'x') return null
  return event.shiftKey ? 'verbatim' : 'summary'
}

/**
 * The viewport slot a Cmd+digit chord addresses, or null if it is not one.
 *
 * Reads `event.code`, not `event.key`: on macOS, Option+digit and Shift+digit
 * produce symbols (`Option+3` is `£`), so matching on `key` loses the save
 * chord entirely. Shift is excluded because Cmd+Shift+3/4/5 are macOS
 * screenshot shortcuts and must not be intercepted.
 */
export function viewportSlotFor(
  event: Pick<KeyboardEvent, 'code' | 'metaKey' | 'shiftKey' | 'altKey'>
): { slot: string; action: 'save' | 'restore' } | null {
  if (!event.metaKey || event.shiftKey) return null
  if (!/^Digit[0-9]$/.test(event.code)) return null
  return {
    slot: event.code.slice('Digit'.length),
    // Option, not Shift, for save — see above.
    action: event.altKey ? 'save' : 'restore'
  }
}
