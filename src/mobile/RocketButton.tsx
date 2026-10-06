import { useSurfacePresenterStore } from '@/stores/surfacePresenterStore'
import { anyPending, usePendingUpdates } from '@/stores/clientStalenessStore'

/**
 * The bottom bar's rocket: opens the toolbar, which on the phone is a sheet
 * with the surfaces in it, and closes it again — the bar stays over it.
 *
 * Sparks run round its rim while something is waiting to bring the phone and
 * the Mac up to date — a flagged server restart, a newer app, a newer page.
 * The sheet's buttons for each march their ants (toolbar/buttons.tsx).
 */
export function RocketButton() {
  const open = useSurfacePresenterStore((s) => s.toolbarSheetOpen)
  const updates = anyPending(usePendingUpdates())
  return (
    <button
      className={`m-bar__button m-rocket${open ? ' m-bar__button--on' : ''}${updates ? ' m-rocket--updates' : ''}`}
      onClick={() => useSurfacePresenterStore.getState().setToolbarSheetOpen(!open)}
      aria-label={open ? 'Back to the canvas' : updates ? 'Toolbar and surfaces — updates waiting' : 'Toolbar and surfaces'}
      aria-expanded={open}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        {/* A rocket climbing to the upper right. */}
        <path d="M20.6 3.4c-3.9-.3-7.6 1.3-10.2 4.3L8.9 9.4l-3.6.4L3 12.1l3.7 1.2 4 4 1.2 3.7 2.3-2.3.4-3.6 1.7-1.5c3-2.6 4.6-6.3 4.3-10.2zM15.5 10.4a1.9 1.9 0 1 1 0-3.8 1.9 1.9 0 0 1 0 3.8z" />
        <path d="M6.2 15.9c-1.3.4-2.2 1.9-2.6 4.5 2.6-.4 4.1-1.3 4.5-2.6z" opacity="0.7" />
      </svg>
      {updates && (
        // pathLength 100: two sparks of 14, opposite each other, one lap a
        // dashoffset of 100 — the directory card's badge spark, twice.
        <svg className="m-rocket__sparks" viewBox="0 0 100 100" aria-hidden="true">
          <circle cx="50" cy="50" r="47" pathLength="100" />
        </svg>
      )}
    </button>
  )
}
