/**
 * A button that stays pressed while its setting is on: in the accent colour
 * when on, grey when off, sized to sit beside a ChoiceGroup. `title` says
 * what it does, as its short label cannot.
 */
export function ToggleButton({ label, title, on, onToggle }: {
  label: string
  title: string
  on: boolean
  onToggle: (on: boolean) => void
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      className={`toggle-button${on ? ' toggle-button--on' : ''}`}
      onClick={() => onToggle(!on)}
    >
      {label}
    </button>
  )
}
