import { useEffect, useRef } from 'react'

export interface ArchiveConfirmProps {
  /** What the card being archived is called, for the sentence the dialog asks. */
  label: string
  /** How many cards go into the archive, the root included. Always 2 or more. */
  count: number
  onConfirm: () => void
  onCancel: () => void
}

/**
 * The one thing standing between Cmd+W and a whole branch of the canvas
 * disappearing.
 *
 * Archiving a card with children takes everything under it, which is a large
 * action to trigger with one keystroke or one small button — so it is the card
 * count, not the gesture, that the dialog leads with. Archiving a leaf asks
 * nothing and never reaches here.
 */
export function ArchiveConfirm({ label, count, onConfirm, onCancel }: ArchiveConfirmProps) {
  const ref = useRef<HTMLDivElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  // Focus the confirm button so Enter and Space act on the dialog rather than
  // on whatever had focus before it opened.
  useEffect(() => { confirmRef.current?.focus() }, [])

  useEffect(() => {
    const cancelOnOutsidePointer = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onCancel()
    }
    document.addEventListener('mousedown', cancelOnOutsidePointer, { capture: true })
    return () => document.removeEventListener('mousedown', cancelOnOutsidePointer, { capture: true })
  }, [onCancel])

  return (
    <section
      ref={ref}
      className="archive-confirm"
      role="alertdialog"
      aria-label="Archive subtree"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <header className="archive-confirm__header">Archive {count} cards?</header>
      <p className="archive-confirm__body">
        <strong>{label}</strong> and the {count - 1} card{count === 2 ? '' : 's'} beneath it go into
        the archive together, and come back together.
      </p>
      <div className="archive-confirm__actions">
        <button className="archive-confirm__button" onClick={onCancel}>
          Cancel <kbd>Esc</kbd>
        </button>
        <button
          ref={confirmRef}
          className="archive-confirm__button archive-confirm__button--primary"
          onClick={onConfirm}
        >
          Archive <kbd>↵</kbd>
        </button>
      </div>
    </section>
  )
}
