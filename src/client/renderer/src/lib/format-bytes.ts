/**
 * Byte counts for a live toolbar readout.
 *
 * The constraint that shapes this is width, not precision. The number is
 * re-read once a second next to other status items, and a figure whose digit
 * count changes with every sample shoves its neighbours around — so the format
 * is fixed at three significant figures (`4.28 GB`, `41.2 GB`, `412 GB`)
 * rather than a fixed number of decimals. Three digits plus a unit stays put
 * for the whole of a unit's range; the only reflow left is the decimal point
 * moving, and the digits are already tabular in the toolbar's CSS.
 *
 * Units are binary (1 KB = 1024 B), matching how the underlying `rss` figure
 * is reported.
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

/** Three significant figures, so the rendered width stays put within a unit. */
function toThreeSigFigs(value: number): string {
  if (value >= 100) return value.toFixed(0)
  if (value >= 10) return value.toFixed(1)
  return value.toFixed(2)
}

export interface FormattedBytes {
  /** The number, as three significant figures. */
  value: string
  unit: (typeof UNITS)[number]
}

/**
 * Split a byte count into a three-significant-figure value and its unit, so a
 * caller can style the unit separately.
 *
 * Bytes are shown whole — `999 B` then `0.98 KB` would be a false precision,
 * and sub-kilobyte readings do not occur in practice anyway.
 */
export function formatBytes(bytes: number): FormattedBytes {
  if (!Number.isFinite(bytes) || bytes <= 0) return { value: '0', unit: 'B' }

  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < UNITS.length - 1) {
    value /= 1024
    unitIndex++
  }

  // Rounding can push 1023.6 KB up to "1024 KB"; carry it into the next unit
  // so the readout never shows a value the unit above should have taken.
  if (Number(toThreeSigFigs(value)) >= 1024 && unitIndex < UNITS.length - 1) {
    value /= 1024
    unitIndex++
  }

  return {
    value: unitIndex === 0 ? value.toFixed(0) : toThreeSigFigs(value),
    unit: UNITS[unitIndex]
  }
}
