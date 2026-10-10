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

/**
 * The text of a paste that has nowhere to land, or null when something will
 * take it.
 *
 * Voice Operator's plain dictation (Fn alone) pastes into whatever has focus.
 * When that is nothing in Spaceterm — no terminal, no title or directory field,
 * no markdown editor — the paste would vanish, so it is treated as the
 * dictation it almost certainly was and sent where a Fn+Control command goes.
 *
 * "Nowhere" is read from the DOM, not from the canvas's idea of which node is
 * focused, because the DOM is what the keystrokes actually follow: a terminal
 * that is selected on the canvas but whose xterm textarea is not focused
 * receives nothing, and one whose textarea is focused receives the paste
 * whatever the canvas thinks. Hence the explicit xterm check —
 * `isTextEditingSurface` deliberately does not count xterm as an editor.
 */
export function strayPasteText(active: Element | null, data: Pick<DataTransfer, 'getData'> | null): string | null {
  if (active?.closest('.xterm') || isTextEditingSurface(active)) return null
  const text = data?.getData('text/plain').trim()
  return text ? text : null
}
