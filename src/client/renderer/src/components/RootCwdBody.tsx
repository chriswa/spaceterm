import { useCallback, useState } from 'react'

interface RootCwdBodyProps {
  initialValue: string
  onSubmit: (cwd: string) => void
}

/**
 * The editor behind the root node's folder button: where everything hung off
 * the root starts.
 *
 * Validated as you type against the same `validateDirectory` check a directory
 * card uses, so a typo says so before it is committed rather than turning into
 * a surface that fails to launch. An empty value is valid and means "no
 * default" — that is how the setting is cleared, so it is not treated as a typo.
 */
export function RootCwdBody({ initialValue, onSubmit }: RootCwdBodyProps) {
  const [value, setValue] = useState(initialValue)
  const [error, setError] = useState<string | null>(null)

  const handleChange = useCallback(async (next: string) => {
    setValue(next)
    if (!next.trim()) {
      setError(null)
      return
    }
    try {
      const result = await window.api.node.validateDirectory(next.trim())
      setError(result.valid ? null : (result.error ?? 'Invalid path'))
    } catch {
      setError(null)
    }
  }, [])

  const handleSubmit = useCallback(async () => {
    const trimmed = value.trim()
    if (!trimmed) {
      onSubmit('')
      return
    }
    try {
      const result = await window.api.node.validateDirectory(trimmed)
      if (result.valid) onSubmit(trimmed)
      else setError(result.error ?? 'Invalid path')
    } catch {
      setError('Could not check that path')
    }
  }, [value, onSubmit])

  return (
    <div className="root-cwd-body" onMouseDown={(e) => e.stopPropagation()}>
      <div className="root-cwd-body__row">
        <input
          className="root-cwd-body__input"
          type="text"
          value={value}
          placeholder="e.g. ~/research"
          autoFocus
          onChange={(e) => { void handleChange(e.target.value) }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') { e.preventDefault(); void handleSubmit() }
          }}
        />
        <button className="root-cwd-body__btn" onClick={() => { void handleSubmit() }}>
          Set
        </button>
      </div>
      {error && <div className="root-cwd-body__error">{error}</div>}
    </div>
  )
}
