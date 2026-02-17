export type AddNodeType = 'claude' | 'title' | 'markdown' | 'directory' | 'file' | 'terminal'

interface AddNodeBodyProps {
  onSelect: (type: AddNodeType) => void
}

const items: Array<{ type: AddNodeType; label: string; hint: string; icon: JSX.Element }> = [
  {
    type: 'claude',
    label: 'Claude Code',
    hint: '\u2318E',
    icon: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 10 L7 4 L10 10" />
        <line x1="5" y1="8" x2="9" y2="8" />
      </svg>
    ),
  },
  {
    type: 'title',
    label: 'Title',
    hint: '',
    icon: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="3" y1="3" x2="11" y2="3" />
        <line x1="7" y1="3" x2="7" y2="11" />
      </svg>
    ),
  },
  {
    type: 'markdown',
    label: 'Markdown',
    hint: '\u2318M',
    icon: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="1" y="3" width="12" height="8" rx="1" />
        <path d="M3 9 L3 5 L5 7 L7 5 L7 9" />
        <path d="M9 7 L11 5 L11 9" />
      </svg>
    ),
  },
  {
    type: 'directory',
    label: 'Directory',
    hint: '\u2318D',
    icon: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 4 V11 Q1 12 2 12 H12 Q13 12 13 11 V5 Q13 4 12 4 H7 L5.5 2 H2 Q1 2 1 3 Z" />
      </svg>
    ),
  },
  {
    type: 'file',
    label: 'File',
    hint: '\u2318O',
    icon: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 1 H9 L11 3 V13 H3 Z" />
        <path d="M9 1 V3 H11" />
      </svg>
    ),
  },
  {
    type: 'terminal',
    label: 'Terminal',
    hint: '\u2318T',
    icon: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 4 L6 7 L3 10" />
        <line x1="7" y1="10" x2="11" y2="10" />
      </svg>
    ),
  },
]

export function AddNodeBody({ onSelect }: AddNodeBodyProps) {
  return (
    <div className="add-node-body" onMouseDown={(e) => e.stopPropagation()}>
      {items.map((item) => (
        <div
          key={item.type}
          className="add-node-body__item"
          onClick={(e) => { e.stopPropagation(); onSelect(item.type) }}
        >
          <span className="add-node-body__icon">{item.icon}</span>
          <span className="add-node-body__label">{item.label}</span>
          <span className="add-node-body__hint">{item.hint}</span>
        </div>
      ))}
    </div>
  )
}
