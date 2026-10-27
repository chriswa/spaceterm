/**
 * A row of buttons joined into one control, exactly one of them chosen: a
 * radio group drawn as a segmented button. Choosing the one already chosen
 * does nothing. `label` is its accessible name.
 */
export function ChoiceGroup<T extends string>({ label, options, value, onChoose }: {
  label: string
  options: readonly { value: T; label: string }[]
  value: T
  onChoose: (value: T) => void
}) {
  return (
    <div className="choice-group" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className={`choice-group__option${option.value === value ? ' choice-group__option--chosen' : ''}`}
          onClick={() => { if (option.value !== value) onChoose(option.value) }}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
