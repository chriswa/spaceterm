/**
 * A row of buttons joined into one control, exactly one of them chosen: a
 * radio group drawn as a segmented button. Choosing the one already chosen
 * does nothing. `caption`, if given, is a short visible name before it;
 * `label` stays its full accessible name.
 */
export function ChoiceGroup<T extends string>({ label, caption, options, value, onChoose }: {
  label: string
  caption?: string
  options: readonly { value: T; label: string }[]
  value: T
  onChoose: (value: T) => void
}) {
  const group = (
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
  if (!caption) return group
  return (
    <div className="choice-field">
      <span className="choice-field__caption" aria-hidden="true">{caption}</span>
      {group}
    </div>
  )
}
