import type { ApprovalSource } from '../shared/approvals'
import { longTimeLeft, providerState, RUNNING_LOW_MS, shortTimeLeft, type ProviderState } from './provider-status'

/**
 * Each approval source's status on the bottom bar, beside the system monitor:
 * a key and the time left on opProxy's 1Password authorization, a struck-out
 * key once it is lost, a dim one while opProxy can't be reached. The figures
 * are in the readouts' panel (MacReadouts.tsx).
 */

function KeyGlyph({ struck }: { struck: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <circle cx="5" cy="8" r="3" />
      <path d="M8 8h6.5M12 8v2.5M14.5 8v2" />
      {struck && <path d="M2 14L14 2" />}
    </svg>
  )
}

function chipText(state: ProviderState, now: number): string {
  if (state.kind === 'unreachable') return '–'
  if (state.kind === 'lost') return 'off'
  return state.status.until === undefined ? 'on' : shortTimeLeft(state.status.until, now)
}

function spoken(name: string, state: ProviderState, now: number): string {
  if (state.kind === 'unreachable') return `${name} can't be reached`
  const label = state.status.label
  if (state.kind === 'lost') return `${label} not authorized`
  return state.status.until === undefined ? `${label} authorized` : `${label} authorized, ${longTimeLeft(state.status.until, now)} left`
}

export function ProviderStatusChips({ sources, now }: { sources: readonly ApprovalSource[]; now: number }) {
  const shown = sources.flatMap((source) => {
    const state = providerState(source)
    return state ? [{ source, state }] : []
  })
  return (
    <>
      {shown.map(({ source, state }) => {
        const low = state.kind === 'ok' && state.status.until !== undefined && state.status.until - now < RUNNING_LOW_MS
        return (
          <span
            key={source.name}
            className={`m-provider m-provider--${low ? 'low' : state.kind}`}
            role="img"
            aria-label={spoken(source.name, state, now)}
          >
            <KeyGlyph struck={state.kind !== 'ok'} />
            <span className="m-provider__text">{chipText(state, now)}</span>
          </span>
        )
      })}
    </>
  )
}

/** The panel's lines: each source's status in words, with the clock time it runs out. */
export function ProviderStatusDetail({ sources, now }: { sources: readonly ApprovalSource[]; now: number }) {
  const rows = sources.flatMap((source) => {
    const state = providerState(source)
    if (!state) return []
    if (state.kind === 'unreachable') return [{ name: source.name, value: 'not running', when: '' }]
    const { label, until } = state.status
    if (state.kind === 'lost') return [{ name: label, value: 'not authorized', when: '' }]
    if (until === undefined) return [{ name: label, value: 'authorized', when: '' }]
    const clock = new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    return [{ name: label, value: `${longTimeLeft(until, now)} left`, when: `until ${clock}` }]
  })
  if (rows.length === 0) return null
  return (
    <div className="m-detail__set">
      <table className="m-detail__table">
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <td className="m-detail__name">{row.name}</td>
              <td>{row.value}</td>
              {row.when && <td className="m-detail__when">{row.when}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
