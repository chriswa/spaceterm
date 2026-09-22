import type { GitStatus } from './state'

/**
 * The badges a directory node draws under its folder — a glanceable summary of
 * the same repo state its git-status line spells out in text.
 *
 * Derived here rather than in the card so the rules are testable without a
 * renderer, and so "am I off the default branch" has exactly one definition.
 */
export type GitBadgeKind =
  /** HEAD is somewhere other than the repo's default branch. */
  | 'off-default'
  /** The remote has commits this checkout does not. */
  | 'behind'
  /** This checkout has commits the remote does not — or no remote branch at all. */
  | 'ahead'
  /** Tracked files have been modified or deleted, staged or not. */
  | 'dirty'
  /** Files exist that git is not tracking. */
  | 'untracked'

export interface GitBadge {
  kind: GitBadgeKind
  /** Hover text, and what the git-status tooltip repeats in longer form. */
  label: string
}

/**
 * Whether HEAD is somewhere other than where work normally lands.
 *
 * `defaultBranch` is the repo's own answer (`refs/remotes/<remote>/HEAD`, which
 * `git clone` sets). When the repo never recorded one — a `git init` working
 * copy, or a clone from a server that did not advertise it — fall back to the
 * main/master convention, which is right often enough to be worth showing and
 * wrong only in the direction of staying quiet.
 *
 * A detached HEAD counts as off-default: there is no branch for work to land on
 * at all, which is at least as worth flagging as being on a feature branch.
 */
export function isOffDefaultBranch(gs: GitStatus): boolean {
  if (gs.branch === null) return true
  if (gs.defaultBranch !== null) return gs.branch !== gs.defaultBranch
  return gs.branch !== 'main' && gs.branch !== 'master'
}

/**
 * Whether there is local work the remote has not seen.
 *
 * Two distinct cases wear the same badge, because the question they answer is
 * the same one — "is this pushed?". `ahead` covers a tracked branch with
 * commits on top of its upstream; a branch with no upstream at all has never
 * been pushed, which is the stronger form of the same thing.
 *
 * The no-upstream case is gated on the repo actually having a remote, so a
 * purely local repo — where nothing is ever pushed by design — does not wear a
 * permanent arrow.
 */
export function hasUnpushedWork(gs: GitStatus): boolean {
  if (gs.ahead) return true
  return gs.hasRemote && gs.branch !== null && gs.upstream === null
}

/** Long-form phrasing for the `off-default` badge, given what the repo told us. */
function offDefaultLabel(gs: GitStatus): string {
  if (gs.branch === null) return 'detached HEAD — not on a branch'
  if (gs.defaultBranch !== null) return `on ${gs.branch}, not the default branch ${gs.defaultBranch}`
  return `on ${gs.branch}, which is not main or master`
}

/** Long-form phrasing for the `ahead` badge — the two cases read differently. */
function aheadLabel(gs: GitStatus): string {
  return gs.ahead ? 'commits to push' : 'branch has never been pushed'
}

/**
 * Every badge this status earns, in display order: which branch, then how it
 * stands against the remote, then what is uncommitted locally.
 */
export function gitBadges(gs: GitStatus): GitBadge[] {
  const badges: GitBadge[] = []
  if (isOffDefaultBranch(gs)) badges.push({ kind: 'off-default', label: offDefaultLabel(gs) })
  if (gs.behind) badges.push({ kind: 'behind', label: 'commits to pull' })
  if (hasUnpushedWork(gs)) badges.push({ kind: 'ahead', label: aheadLabel(gs) })
  // Staged and unstaged share one badge: both mean tracked files differ from
  // HEAD, and `git add` should not make a dirty tree look clean.
  if (gs.dirty) badges.push({ kind: 'dirty', label: 'uncommitted changes' })
  if (gs.untracked) badges.push({ kind: 'untracked', label: 'untracked files' })
  return badges
}

/**
 * The marks the status line puts after the branch name, in badge order.
 *
 * One character each, so a caller sizing a monospace line can count them
 * directly rather than guessing.
 */
const STATUS_MARKS: Array<{ mark: string; applies: (gs: GitStatus) => boolean }> = [
  { mark: '⇡', applies: hasUnpushedWork },
  { mark: '⇣', applies: (gs) => gs.behind },
  { mark: '!', applies: (gs) => gs.dirty },
  { mark: '?', applies: (gs) => gs.untracked },
  { mark: '=', applies: (gs) => gs.conflicts },
]

/**
 * The one-line summary a directory node shows beside its folder: the branch,
 * then a mark for each thing that wants attention.
 *
 * Defined here rather than in the card because the card is not the only caller
 * — the folder is sized from this line's length before it is ever rendered, and
 * a width computed from a different format than the one drawn is a folder that
 * clips its own text.
 */
export function formatGitStatusLine(gs: GitStatus): string {
  const marks = STATUS_MARKS.filter(({ applies }) => applies(gs)).map(({ mark }) => mark).join('')
  const branch = gs.branch ?? 'detached'
  return marks === '' ? branch : `${branch} ${marks}`
}
