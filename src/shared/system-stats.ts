/**
 * The Mac's system monitor, as mini-stats (~/mini-stats) draws it in the menu
 * bar: a bar chart per module, then the battery. The server reads what
 * mini-stats exports and sends this; see src/server/system-stats.ts.
 *
 * mini-stats exports what it draws, not its settings — sizes in menu-bar
 * points and colours already decided — so the phone only paints.
 */

/** One stacked piece of a bar. */
export interface SystemStatsSegment {
  /** Fraction of the bar's height. */
  value: number
  /** CSS hex colour. */
  color: string
}

export interface SystemStatsBars {
  kind: 'bars'
  /** The module, e.g. "CPU" — for a label. */
  module: string
  /** The chart's size in menu-bar points. */
  width: number
  height: number
  /** Drawn on a black box with a faint edge. */
  box: boolean
  /** Stacked letters drawn in black down the top of each bar, clipped to it. */
  label?: string
  /** Each bar, bottom segment first. */
  bars: SystemStatsSegment[][]
}

export interface SystemStatsBattery {
  kind: 'battery'
  module: string
  /** The battery body's size in menu-bar points, without its terminal nub. */
  width: number
  height: number
  /** Absent when the level is unknown. */
  level?: number
  fill?: string
  /** Present when the percentage is drawn inside: the empty part's colour, and the digits' colours over each part. */
  track?: string
  textOnFill?: string
  textOnTrack?: string
  /** A plug or bolt drawn over the battery, in place of the percentage. */
  charger: 'none' | 'plugged' | 'charging'
}

export type SystemStatsWidget = SystemStatsBars | SystemStatsBattery

export interface SystemStatsSnapshot {
  /** Gap between modules, in menu-bar points. */
  spacing: number
  widgets: SystemStatsWidget[]
}
