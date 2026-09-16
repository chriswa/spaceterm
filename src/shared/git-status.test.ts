import { describe, it, expect } from 'vitest'
import { gitBadges, hasUnpushedWork, isOffDefaultBranch } from './git-status'
import type { GitStatus } from './state'

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: 'main',
    defaultBranch: 'main',
    upstream: 'origin/main',
    hasRemote: true,
    ahead: 0,
    behind: 0,
    conflicts: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    lastFetchTimestamp: null,
    ...overrides
  }
}

const kinds = (gs: GitStatus) => gitBadges(gs).map(b => b.kind)

describe('off the default branch', () => {
  it('stays quiet on the branch the repo names as default', () => {
    expect(isOffDefaultBranch(status({ branch: 'trunk', defaultBranch: 'trunk' }))).toBe(false)
  })

  it('believes the repo over the main/master convention', () => {
    // A repo whose default is `develop` should not flag it, and *should* flag
    // `master` — the convention is only a fallback, never an override.
    expect(isOffDefaultBranch(status({ branch: 'develop', defaultBranch: 'develop' }))).toBe(false)
    expect(isOffDefaultBranch(status({ branch: 'master', defaultBranch: 'develop' }))).toBe(true)
  })

  it('falls back to main/master when the repo recorded no default', () => {
    expect(isOffDefaultBranch(status({ branch: 'main', defaultBranch: null }))).toBe(false)
    expect(isOffDefaultBranch(status({ branch: 'master', defaultBranch: null }))).toBe(false)
    expect(isOffDefaultBranch(status({ branch: 'feature/x', defaultBranch: null }))).toBe(true)
  })

  it('treats a detached HEAD as off-default', () => {
    expect(isOffDefaultBranch(status({ branch: null }))).toBe(true)
  })
})

describe('unpushed work', () => {
  it('flags commits sitting on top of the upstream', () => {
    expect(hasUnpushedWork(status({ ahead: 2 }))).toBe(true)
  })

  it('flags a branch that has no upstream at all', () => {
    expect(hasUnpushedWork(status({ branch: 'wip', upstream: null }))).toBe(true)
  })

  it('leaves a repo with no remote alone', () => {
    // Nothing is ever pushed here by design, so a permanent arrow would be noise.
    expect(hasUnpushedWork(status({ branch: 'wip', upstream: null, hasRemote: false }))).toBe(false)
  })

  it('leaves a detached HEAD alone', () => {
    expect(hasUnpushedWork(status({ branch: null, upstream: null }))).toBe(false)
  })
})

describe('the badge set', () => {
  it('shows nothing for a clean checkout of the default branch', () => {
    expect(kinds(status())).toEqual([])
  })

  it('orders them branch, pull, push, dirty, untracked', () => {
    const gs = status({ branch: 'wip', upstream: 'origin/wip', ahead: 1, behind: 3, unstaged: 2, untracked: 1 })
    expect(kinds(gs)).toEqual(['off-default', 'behind', 'ahead', 'dirty', 'untracked'])
  })

  it('counts staged changes as dirty', () => {
    // `git add` moves a change between counters; it does not make it committed.
    expect(kinds(status({ staged: 1 }))).toEqual(['dirty'])
    expect(gitBadges(status({ staged: 1, unstaged: 2 }))[0].label).toBe('3 uncommitted changes')
  })

  it('keeps untracked files separate from modifications', () => {
    expect(kinds(status({ untracked: 4 }))).toEqual(['untracked'])
  })

  it('singularises its counts', () => {
    expect(gitBadges(status({ behind: 1 }))[0].label).toBe('1 commit to pull')
    expect(gitBadges(status({ untracked: 1 }))[0].label).toBe('1 untracked file')
  })

  it('says which branch it expected', () => {
    const gs = status({ branch: 'wip', defaultBranch: 'trunk' })
    expect(gitBadges(gs)[0].label).toBe('on wip, not the default branch trunk')
  })
})
