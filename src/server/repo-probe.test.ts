import { describe, it, expect } from 'vitest'
import { RepoProbe, parseGitStatus, UNKNOWN_REPO_FACTS, type RepoProbeDeps } from './repo-probe'
import type { GitStatus } from '../shared/state'

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: 'main',
    defaultBranch: 'main',
    upstream: null,
    hasRemote: false,
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

/**
 * A scripted repository: git answers keyed by the first meaningful argument,
 * and an mtime per path. Both are mutable, so a test can move the repo under a
 * probe the way a commit or a checkout would.
 */
function fakeRepo(options: {
  status?: string
  remotes?: string
  refs?: string
} = {}) {
  const calls: string[][] = []
  const mtimes = new Map<string, number>()
  const answers = {
    status: options.status ?? '# branch.head main',
    remotes: options.remotes ?? '',
    refs: options.refs ?? '',
  }
  let repoExists = true

  const deps: RepoProbeDeps = {
    async git(_cwd, args) {
      calls.push(args)
      if (!repoExists) throw new Error('not a git repository')
      if (args.includes('status')) return answers.status
      if (args[0] === 'rev-parse') return '/repo/.git\n/repo/.git\n'
      if (args[0] === 'for-each-ref') return answers.refs
      if (args[0] === 'remote') return answers.remotes
      throw new Error(`unscripted: ${args.join(' ')}`)
    },
    async mtimeMs(path) {
      return mtimes.get(path) ?? null
    },
  }

  return {
    deps,
    answers,
    calls,
    /** Commands run since the last `reset`, by their first argument. */
    commandNames: () => calls.map((c) => c.find((a) => !a.startsWith('--')) ?? c[0]),
    clearCalls: () => { calls.length = 0 },
    touch: (gitRelativePath: string, at: number) => mtimes.set(`/repo/.git/${gitRelativePath}`, at),
    setRepoExists: (exists: boolean) => { repoExists = exists },
  }
}

describe('status', () => {
  it('asks git not to take the index lock', async () => {
    const repo = fakeRepo()
    await new RepoProbe('/repo', repo.deps).status()

    const statusCall = repo.calls.find((c) => c.includes('status'))
    expect(statusCall).toContain('--no-optional-locks')
  })

  it('returns null for a directory that is not a repository', async () => {
    const repo = fakeRepo()
    repo.setRepoExists(false)
    expect(await new RepoProbe('/repo', repo.deps).status()).toBeNull()
  })

  it('folds the facts in with the porcelain', async () => {
    const repo = fakeRepo({ remotes: 'origin', refs: 'refs/remotes/origin/HEAD\torigin/trunk' })
    repo.touch('FETCH_HEAD', 1_700_000_000_000)

    expect(await new RepoProbe('/repo', repo.deps).status())
      .toEqual(status({ defaultBranch: 'trunk', hasRemote: true, lastFetchTimestamp: 1_700_000_000_000 }))
  })
})

describe('facts caching', () => {
  it('re-reads the facts only once while the repo sits still', async () => {
    const repo = fakeRepo({ remotes: 'origin' })
    const probe = new RepoProbe('/repo', repo.deps)

    await probe.status()
    expect(repo.commandNames()).toContain('for-each-ref')

    repo.clearCalls()
    await probe.status()
    await probe.status()

    // Only the working-tree walk repeats; the seldom-changing facts do not.
    expect(repo.commandNames()).toEqual(['status', 'status'])
  })

  it('re-reads the facts when the git metadata moves', async () => {
    const repo = fakeRepo({ remotes: 'origin' })
    const probe = new RepoProbe('/repo', repo.deps)
    await probe.status()
    repo.clearCalls()

    repo.touch('HEAD', 1_000)
    await probe.status()

    expect(repo.commandNames()).toContain('for-each-ref')
  })

  it('re-reads the facts when the branch starts tracking a different remote', async () => {
    const repo = fakeRepo({ status: '# branch.head main\n# branch.upstream origin/main' })
    const probe = new RepoProbe('/repo', repo.deps)
    await probe.status()
    repo.clearCalls()

    // Same metadata mtimes, but the remote the facts describe has changed.
    repo.answers.status = '# branch.head main\n# branch.upstream fork/main'
    await probe.status()

    const refsCall = repo.calls.find((c) => c[0] === 'for-each-ref')
    expect(refsCall?.join(' ')).toContain('refs/remotes/fork/HEAD')
  })

  it('re-reads everything after a reset', async () => {
    const repo = fakeRepo({ remotes: 'origin' })
    const probe = new RepoProbe('/repo', repo.deps)
    await probe.status()
    repo.clearCalls()

    probe.reset()
    await probe.status()

    expect(repo.commandNames()).toContain('for-each-ref')
  })
})

describe('metadataMoved', () => {
  it('is true before the first status, so a fresh repo is read', async () => {
    const repo = fakeRepo()
    expect(await new RepoProbe('/repo', repo.deps).metadataMoved()).toBe(true)
  })

  it('is false while nothing under .git changes', async () => {
    const repo = fakeRepo()
    const probe = new RepoProbe('/repo', repo.deps)
    await probe.status()

    expect(await probe.metadataMoved()).toBe(false)
  })

  it('costs no subprocess once the layout is known', async () => {
    const repo = fakeRepo()
    const probe = new RepoProbe('/repo', repo.deps)
    await probe.status()
    repo.clearCalls()

    await probe.metadataMoved()

    expect(repo.calls).toEqual([])
  })

  it('notices HEAD moving', async () => {
    const repo = fakeRepo()
    const probe = new RepoProbe('/repo', repo.deps)
    await probe.status()

    repo.touch('HEAD', 1_000)
    expect(await probe.metadataMoved()).toBe(true)
  })

  it('notices a fetch', async () => {
    const repo = fakeRepo()
    const probe = new RepoProbe('/repo', repo.deps)
    await probe.status()

    repo.touch('FETCH_HEAD', 1_000)
    expect(await probe.metadataMoved()).toBe(true)
  })

  it('goes quiet again once the status that follows has run', async () => {
    const repo = fakeRepo()
    const probe = new RepoProbe('/repo', repo.deps)
    await probe.status()
    repo.touch('index', 1_000)
    expect(await probe.metadataMoved()).toBe(true)

    await probe.status()
    expect(await probe.metadataMoved()).toBe(false)
  })

  it('stays quiet for a directory that is not a repository', async () => {
    const repo = fakeRepo()
    repo.setRepoExists(false)
    const probe = new RepoProbe('/repo', repo.deps)
    await probe.status()

    expect(await probe.metadataMoved()).toBe(false)
  })
})

describe('parseGitStatus', () => {
  it('reads the branch and upstream', () => {
    const out = ['# branch.head main', '# branch.upstream origin/main'].join('\n')
    expect(parseGitStatus(out, UNKNOWN_REPO_FACTS)).toMatchObject({ branch: 'main', upstream: 'origin/main' })
  })

  it('reports a detached HEAD as no branch', () => {
    expect(parseGitStatus('# branch.head (detached)', UNKNOWN_REPO_FACTS).branch).toBeNull()
  })

  it('reads ahead/behind counts', () => {
    expect(parseGitStatus('# branch.ab +3 -5', UNKNOWN_REPO_FACTS)).toMatchObject({ ahead: 3, behind: 5 })
  })

  it('counts staged and unstaged changes from the XY field', () => {
    const out = [
      '1 M. N... 100644 100644 100644 aaa bbb staged-only.ts',
      '1 .M N... 100644 100644 100644 aaa bbb unstaged-only.ts',
      '1 MM N... 100644 100644 100644 aaa bbb both.ts'
    ].join('\n')

    expect(parseGitStatus(out, UNKNOWN_REPO_FACTS)).toMatchObject({ staged: 2, unstaged: 2 })
  })

  it('counts renames, which use the 2 prefix', () => {
    expect(parseGitStatus('2 R. N... 100644 100644 100644 aaa bbb R100 new.ts\told.ts', UNKNOWN_REPO_FACTS))
      .toMatchObject({ staged: 1 })
  })

  it('counts conflicts and untracked files', () => {
    const out = ['u UU N... 100644 100644 100644 100644 a b c d conflicted.ts', '? new-file.ts'].join('\n')
    expect(parseGitStatus(out, UNKNOWN_REPO_FACTS)).toMatchObject({ conflicts: 1, untracked: 1 })
  })

  it('folds in the facts git status cannot report', () => {
    const facts = { lastFetchTimestamp: 1_700_000_000_000, defaultBranch: 'trunk', hasRemote: true }
    expect(parseGitStatus('# branch.head main', facts)).toMatchObject(facts)
  })

  it('returns a clean status for empty output', () => {
    expect(parseGitStatus('', UNKNOWN_REPO_FACTS))
      .toEqual(status({ branch: null, upstream: null, defaultBranch: null, hasRemote: false }))
  })
})
