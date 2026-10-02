import type { PtySessionId } from '../shared/ids'

/**
 * The keys a phone keyboard does not have, as bytes straight to the pty.
 *
 * Arrows are sent in their normal-mode form (`ESC [ A`). Ink — which Claude
 * Code's TUI, including AskUserQuestion, is built on — and readline accept it
 * in either cursor mode.
 */
const KEYS: Array<{ label: string; bytes: string; title: string }> = [
  { label: 'esc', bytes: '\x1b', title: 'Escape' },
  { label: 'tab', bytes: '\t', title: 'Tab' },
  { label: '⇧tab', bytes: '\x1b[Z', title: 'Shift+Tab' },
  { label: '←', bytes: '\x1b[D', title: 'Left' },
  { label: '↓', bytes: '\x1b[B', title: 'Down' },
  { label: '↑', bytes: '\x1b[A', title: 'Up' },
  { label: '→', bytes: '\x1b[C', title: 'Right' },
  { label: '⏎', bytes: '\r', title: 'Enter' },
  // Ink reads ESC+CR as meta+return: a newline in Claude's prompt, not a submit.
  { label: '⇧⏎', bytes: '\x1b\r', title: 'Newline without submitting' },
  { label: '^C', bytes: '\x03', title: 'Ctrl+C' }
]

const keepFocus = (e: { preventDefault(): void }) => e.preventDefault()

export function KeyRow({ sessionId, onKeyboard }: { sessionId: PtySessionId; onKeyboard: () => void }) {
  const send = (bytes: string) => window.api.pty.write(sessionId, bytes)
  return (
    <div className="mobile-keys" role="toolbar" aria-label="Terminal keys">
      {KEYS.map((k) => (
        <button
          key={k.title}
          className="mobile-keys__key"
          title={k.title}
          // The press itself is swallowed so the tap never takes focus from
          // the terminal and dismisses the on-screen keyboard; the key fires on
          // click, which every touch browser delivers for a tap.
          onPointerDown={keepFocus}
          onMouseDown={keepFocus}
          onClick={() => send(k.bytes)}
        >
          {k.label}
        </button>
      ))}
      <button
        className="mobile-keys__key mobile-keys__key--wide"
        title="Type into the terminal"
        onPointerDown={keepFocus}
        onMouseDown={keepFocus}
        onClick={onKeyboard}
      >
        ⌨
      </button>
    </div>
  )
}
