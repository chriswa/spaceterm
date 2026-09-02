import { useEffect, useRef } from 'react'
import type { AgentType } from '../../../../shared/agent-type'

export const AGENT_SELECTOR_OPTIONS: ReadonlyArray<{ type: AgentType; key: string; label: string }> = [
  { type: 'claude', key: '1', label: 'Claude Code' },
  { type: 'codex', key: '2', label: 'Codex' },
  { type: 'cursor', key: '3', label: 'Cursor Agent' },
]

interface AgentSelectorProps {
  onSelect: (agent: AgentType) => void
  onDismiss: () => void
}

/** A launch surface that deliberately leaves no graph or persistence trace when dismissed. */
export function AgentSelector({ onSelect, onDismiss }: AgentSelectorProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const dismissOnOutsidePointer = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onDismiss()
    }
    document.addEventListener('mousedown', dismissOnOutsidePointer, { capture: true })
    return () => document.removeEventListener('mousedown', dismissOnOutsidePointer, { capture: true })
  }, [onDismiss])

  return (
    <section ref={ref} className="agent-selector" aria-label="Start an agent" onMouseDown={(event) => event.stopPropagation()}>
      <header className="agent-selector__header">
        <span>Start an agent</span>
        <kbd>Esc</kbd>
      </header>
      <div className="agent-selector__options">
        {AGENT_SELECTOR_OPTIONS.map((option) => (
          <button key={option.type} className="agent-selector__option" onClick={() => onSelect(option.type)}>
            <kbd className="agent-selector__key">{option.key}</kbd>
            <span>{option.label}</span>
          </button>
        ))}
      </div>
    </section>
  )
}
