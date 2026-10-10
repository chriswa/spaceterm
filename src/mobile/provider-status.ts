import type { ApprovalSource, ApprovalsSnapshot, ProviderStatus } from '../shared/approvals'

/**
 * What each approval source depends on — opProxy's 1Password authorization —
 * as its feed reports it (APPROVAL_FEED.md, "Provider status"). The bottom bar
 * shows the time left beside the system monitor (ProviderStatusReadout.tsx),
 * and a lost status is a notification like an approval request.
 */

export type ProviderState =
  | { kind: 'ok'; status: ProviderStatus }
  | { kind: 'lost'; status: ProviderStatus }
  /** The feed isn't connected: the provider isn't running, or is too old to have one. */
  | { kind: 'unreachable' }

/** null when there is nothing to show: connected, but the provider sends no status. */
export function providerState(source: ApprovalSource): ProviderState | null {
  if (!source.connected) return { kind: 'unreachable' }
  if (!source.status) return null
  return { kind: source.status.ok ? 'ok' : 'lost', status: source.status }
}

/** A lost status with its source, as the sheet's notifications show it. */
export interface LostStatus { source: string; status: ProviderStatus }

export function lostStatuses(snapshot: ApprovalsSnapshot): LostStatus[] {
  return snapshot.sources.flatMap((s) => (s.connected && s.status && !s.status.ok ? [{ source: s.name, status: s.status }] : []))
}

/** Each loss is its own notice: lost again later is unread again. */
export const statusNoticeKey = ({ source, status }: LostStatus) => `status:${source}:${status.since}`

export function lostStatusKeys(snapshot: ApprovalsSnapshot): string[] {
  return lostStatuses(snapshot).map(statusNoticeKey)
}

/** The bar's label, as opProxy's menu bar rounds it: "12h" from 11h 30m up, then minutes, "<1m" under 30 s. */
export function shortTimeLeft(until: number, now: number): string {
  const s = Math.max(0, (until - now) / 1000)
  if (s < 30) return '<1m'
  if (s < 59.5 * 60) return `${Math.round(s / 60)}m`
  return `${Math.round(s / 3600)}h`
}

/** The details' figure: "11h 32m", "32m", "<1m". */
export function longTimeLeft(until: number, now: number): string {
  const s = Math.max(0, (until - now) / 1000)
  if (s < 60) return '<1m'
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Under an hour left: worth noticing before it runs out. */
export const RUNNING_LOW_MS = 60 * 60_000
