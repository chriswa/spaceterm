import { useRef, useState } from 'react'

interface WtSpawnBodyProps {
  onSubmit: (branchName: string) => void
}

export function WtSpawnBody({ onSubmit }: WtSpawnBodyProps) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const handleSubmit = () => {
    const trimmed = value.trim()
    if (trimmed) onSubmit(trimmed)
  }

  return (
    <div className="wt-spawn-body" onMouseDown={(e) => e.stopPropagation()}>
      <div className="wt-spawn-body__row">
        <input
          ref={inputRef}
          className="wt-spawn-body__input"
          type="text"
          value={value}
          placeholder="branch name"
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') handleSubmit()
          }}
        />
        <button className="wt-spawn-body__btn" onClick={handleSubmit} disabled={!value.trim()}>
          Create
        </button>
      </div>
    </div>
  )
}
