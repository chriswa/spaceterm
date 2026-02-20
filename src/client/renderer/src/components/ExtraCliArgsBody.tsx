import { useRef, useState } from 'react'

interface ExtraCliArgsBodyProps {
  initialValue: string
  onRestart: (extraCliArgs: string) => void
}

export function ExtraCliArgsBody({ initialValue, onRestart }: ExtraCliArgsBodyProps) {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleSubmit = () => {
    onRestart(value)
  }

  return (
    <div className="extra-cli-args-body" onMouseDown={(e) => e.stopPropagation()}>
      <div className="extra-cli-args-body__row">
        <input
          ref={inputRef}
          className="extra-cli-args-body__input"
          type="text"
          value={value}
          placeholder="e.g. --chrome --model opus"
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') handleSubmit()
          }}
        />
        <button className="extra-cli-args-body__btn" onClick={handleSubmit}>
          Restart
        </button>
      </div>
    </div>
  )
}
