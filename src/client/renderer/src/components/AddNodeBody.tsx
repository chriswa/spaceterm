import crabIcon from '../assets/crab.png'
import codexAgentIcon from '../assets/codex-agent.png'
import type { AgentType } from '../../../../shared/agent-type'
import type { CardType } from '../../../../shared/card-types'

/**
 * What the add menu can create: a card of any registered type, plus one entry
 * per agent (all of which produce a terminal card, pre-launched with that CLI).
 */
export type AddNodeType = AgentType | CardType

interface AddNodeBodyProps {
  onSelect: (type: AddNodeType) => void
}

const items: Array<{ type: AddNodeType; label: string; hint: string; icon: JSX.Element }> = [
  {
    type: 'claude',
    label: 'Claude Code',
    hint: '',
    icon: (
      <span
        className="add-node-body__mask-icon"
        style={{
          maskImage: `url(${crabIcon})`,
          WebkitMaskImage: `url(${crabIcon})`,
          width: 14,
          height: 9,
        }}
      />
    ),
  },
  {
    type: 'cursor',
    label: 'Cursor Agent',
    hint: '',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" />
      </svg>
    ),
  },
  {
    type: 'codex',
    label: 'Codex',
    hint: '',
    icon: (
      <span
        className="add-node-body__mask-icon"
        style={{
          maskImage: `url(${codexAgentIcon})`,
          WebkitMaskImage: `url(${codexAgentIcon})`,
          maskSize: '110%',
          WebkitMaskSize: '110%',
          width: 14,
          height: 14,
        }}
      />
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
    hint: '',
    icon: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 4 V11 Q1 12 2 12 H12 Q13 12 13 11 V5 Q13 4 12 4 H7 L5.5 2 H2 Q1 2 1 3 Z" />
      </svg>
    ),
  },
  {
    type: 'file',
    label: 'File',
    hint: '',
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
