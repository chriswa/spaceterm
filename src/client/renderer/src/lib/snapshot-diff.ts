import type { SnapshotRow } from '../../../../shared/protocol'

/**
 * Whether two snapshot rows would paint identically.
 *
 * The server re-serializes the whole screen every tick, so a snapshot that
 * differs by one character arrives as `rows` fresh row objects. Repainting all
 * of them costs one fillText per glyph on the whole grid — around 7000 cells at
 * the default 160x45 — when a TUI typically touches a handful of lines between
 * frames. Comparing rows is cheap next to drawing them.
 *
 * Field-by-field rather than JSON.stringify: this runs `rows` times per
 * snapshot and stringify would allocate two strings per row to answer a
 * question that usually resolves on the first span's text.
 */
/** What the canvas currently shows: the rows, and the conditions they were
 *  drawn under. See `planRepaint` for what belongs in `key`. */
export interface PaintedState {
  key: string
  lines: SnapshotRow[]
}

/** Repaint everything, or just these row indices. */
export type RepaintPlan =
  | { kind: 'full' }
  | { kind: 'rows'; rows: number[] }

/**
 * Decide how much of the canvas the next snapshot has to redraw.
 *
 * `key` must fold in every condition that would change how *any* row is drawn —
 * bitmap size, background colour, font — because a row that is byte-identical
 * to the last one still needs redrawing if the font changed underneath it.
 * Getting that wrong is the failure mode this function exists to make testable:
 * it shows up as a card that keeps stale pixels until something unrelated
 * forces a full repaint, which is exactly the kind of bug that survives review.
 *
 * `forceFull` is for conditions the caller knows about that the key cannot
 * express — chiefly that assigning to canvas.width has just blanked the bitmap.
 */
export function planRepaint(
  previous: PaintedState | null,
  key: string,
  lines: SnapshotRow[],
  forceFull = false
): RepaintPlan {
  if (forceFull || !previous || previous.key !== key) return { kind: 'full' }

  const rows: number[] = []
  for (let y = 0; y < lines.length; y++) {
    if (!sameRow(previous.lines[y], lines[y])) rows.push(y)
  }
  return { kind: 'rows', rows }
}

export function sameRow(a: SnapshotRow | undefined, b: SnapshotRow | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.text !== y.text ||
      x.fg !== y.fg ||
      x.bg !== y.bg ||
      !!x.bold !== !!y.bold ||
      !!x.italic !== !!y.italic ||
      !!x.underline !== !!y.underline
    ) {
      return false
    }
  }
  return true
}
