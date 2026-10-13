/**
 * Features that are built but deliberately not reachable.
 *
 * A flag here is not a half-measure toward deleting something — it is how a
 * feature waits. The code, its tests and its persisted state stay exactly as
 * they are; only the ways in are closed, so the feature cannot be reached by
 * accident while nobody is working on it.
 */

/**
 * The agent-meta branch: CLAUDE.md and skills as generated cards.
 *
 * Off because the feature was never confirmed working end to end. The server
 * logic and both card components have unit and jsdom coverage, but nobody has
 * watched it run, and the last two bugs found in it — a PUSH with no matching
 * PULL, and a marketplace scanned as an either/or — were both the kind that
 * only show up in the running app. Leaving a button that might half-work is
 * worse than leaving no button.
 *
 * Turning it back on is this one line. Nothing else was removed: see
 * `docs/AGENT_META.md` for the design, and the known gaps at the end of it for
 * where to pick up.
 *
 * Read in two places, which between them are every way in:
 *  - `App.tsx` withholds the toolbar button from directory nodes and the root.
 *  - `server/index.ts` skips the availability sweep and the startup restore, and
 *    refuses `agent-meta-toggle` — so a branch already recorded as open stays
 *    closed, and no script or mod can open one behind the missing button.
 */
export const AGENT_META_ENABLED = false
