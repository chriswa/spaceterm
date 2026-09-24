/**
 * The stamps a user can drop on the canvas.
 *
 * A stamp is a marker, not a card: it has a position and a glyph and nothing
 * else. The glyphs themselves are drawn by the renderer (`stamp-art.tsx`); this
 * is the list both sides agree on, so the server can refuse a kind the
 * renderer would have nothing to draw for.
 */
export const STAMP_KINDS = ['star', 'double-exclamation'] as const
export type StampKind = (typeof STAMP_KINDS)[number]

export function isStampKind(value: unknown): value is StampKind {
  return typeof value === 'string' && (STAMP_KINDS as readonly string[]).includes(value)
}

/** Human-readable name of each stamp, for menus and search. */
export const STAMP_LABELS: Record<StampKind, string> = {
  star: 'Gold star',
  'double-exclamation': 'Double exclamation'
}
