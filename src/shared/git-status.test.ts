import { describe, it, expect } from 'vitest'
import { gitBadges, hasUnpushedWork, isOffDefaultBranch } from './git-status'
import type { GitStatus } from './state'

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: 'main',
    defaultBranch: 'main',
    upstream: 'origin/main',
    hasRemote: true,
    ahead: false,
    behind: false,
    conflicts: false,
    dirty: false,
    untracked: false,
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
    expect(hasUnpushedWork(status({ ahead: true }))).toBe(true)
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
    const gs = status({ branch: 'wip', upstream: 'origin/wip', ahead: true, behind: true, dirty: true, untracked: true })
    expect(kinds(gs)).toEqual(['off-default', 'behind', 'ahead', 'dirty', 'untracked'])
  })

  it('keeps untracked files separate from modifications', () => {
    expect(kinds(status({ untracked: true }))).toEqual(['untracked'])
    expect(kinds(status({ dirty: true }))).toEqual(['dirty'])
  })

  it('names what each mark means, without a count', () => {
    expect(gitBadges(status({ behind: true }))[0].label).toBe('commits to pull')
    expect(gitBadges(status({ dirty: true }))[0].label).toBe('uncommitted changes')
    expect(gitBadges(status({ untracked: true }))[0].label).toBe('untracked files')
  })

  it('says which branch it expected', () => {
    const gs = status({ branch: 'wip', defaultBranch: 'trunk' })
    expect(gitBadges(gs)[0].label).toBe('on wip, not the default branch trunk')
  })
})
