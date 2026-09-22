/**
 * The mark on the button that sets the root node's working directory: the same
 * folder silhouette a directory card draws, so the two read as the same idea —
 * one placed on the canvas, one standing behind everything on it.
 *
 * Its own module because both button rows draw it: the action bar the floating
 * toolbar renders, and the hidden head row on the root disc itself.
 */
export function RootCwdGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.5 11.5 L1.5 3 L5.5 3 L6.8 4.6 L12.5 4.6 L12.5 11.5 Z" />
    </svg>
  )
}
