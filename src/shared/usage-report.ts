/**
 * AI usage, as AI Spend Tracker's menu-bar bars show it: one bar per
 * rate-limit window, plus month-to-date spend. The server reads the tracker
 * and sends this; see src/server/usage-tracker.ts.
 *
 * Only what the bars draw crosses the wire — the tracker's full report is
 * several times larger, and the phone may be on LTE.
 */

/** The tracker's palettes, by name; the client owns the colours. */
export type UsagePalette = 'claude' | 'codex' | 'cursor' | 'devin' | 'jev' | 'scoped' | 'spend'

export interface UsageBar {
  /** Who and which window, e.g. "Claude 5-Hour" — for a tooltip or label. */
  label: string
  palette: UsagePalette
  /** The provider's last fetch failed: draw a warning, not a bar. */
  error?: boolean
  /** Fraction of the allowance used. May exceed 1. */
  usage: number
  /** Fraction of the window elapsed, as of the reading. */
  time: number
  /** First bar of a provider (or the spend bar): a wider gap before it. */
  startsGroup: boolean
}

export interface UsageSnapshot {
  bars: UsageBar[]
  /** When the newest reading was taken by the tracker (ms since epoch), or null if none has been. */
  updatedAt: number | null
}
