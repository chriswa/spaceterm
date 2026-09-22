import { describe, it, expect } from 'vitest'
import { RepoProbe, parseGitStatus, UNKNOWN_REPO_FACTS, type RepoProbeDeps } from './repo-probe'
import type { GitStatus } from '../shared/state'

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: 'main',
    defaultBranch: 'main',
    upstream: null,
    hasRemote: false,
    ahead: false,
    behind: false,
    conflicts: false,
    dirty: false,
    untracked: false,
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
  /** The commit the remote is advertising, or null for an unreachable remote. */
  let remoteHead: string | null = null
  /** Commits this checkout has locally. */
  const localCommits = new Set<string>()
  const remoteCalls: string[][] = []

  const deps: RepoProbeDeps = {
    async git(_cwd, args) {
      calls.push(args)
      if (!repoExists) throw new Error('not a git repository')
      if (args.includes('status')) return answers.status
      if (args[0] === 'rev-parse') return '/repo/.git\n/repo/.git\n'
      if (args[0] === 'for-each-ref') return answers.refs
      if (args[0] === 'remote') return answers.remotes
      if (args[0] === 'cat-file') {
        const sha = args[2].replace('^{commit}', '')
        if (!localCommits.has(sha)) throw new Error('not found')
        return ''
      }
      throw new Error(`unscripted: ${args.join(' ')}`)
    },
    async gitRemote(_cwd, args) {
      remoteCalls.push(args)
      if (remoteHead === null) throw new Error('could not read from remote')
      return `${remoteHead}\trefs/heads/${args[args.length - 1]}\n`
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
    remoteCalls,
    /** Put this commit on the remote. Pass null to make the remote unreachable. */
    setRemoteHead: (sha: string | null) => { remoteHead = sha },
    /** Say this checkout has that commit, as a pull would. */
    pull: (sha: string) => { localCommits.add(sha); mtimes.set('/repo/.git/HEAD', Date.now()) },
  }
}

const TRACKING_MAIN = '# branch.head main\n# branch.upstream origin/main'
const REMOTE_SHA = 'a'.repeat(40)

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

  it('reads whether the branch is ahead or behind, not by how much', () => {
    expect(parseGitStatus('# branch.ab +3 -5', UNKNOWN_REPO_FACTS)).toMatchObject({ ahead: true, behind: true })
    expect(parseGitStatus('# branch.ab +0 -0', UNKNOWN_REPO_FACTS)).toMatchObject({ ahead: false, behind: false })
    expect(parseGitStatus('# branch.ab +0 -2', UNKNOWN_REPO_FACTS)).toMatchObject({ ahead: false, behind: true })
  })

  it('reads either half of the XY field as dirty', () => {
    for (const xy of ['M.', '.M', 'MM', 'A.', '.D']) {
      expect(parseGitStatus(`1 ${xy} N... 100644 100644 100644 aaa bbb f.ts`, UNKNOWN_REPO_FACTS).dirty)
        .toBe(true)
    }
  })

  it('reads an unmodified entry as clean', () => {
    expect(parseGitStatus('1 .. N... 100644 100644 100644 aaa bbb f.ts', UNKNOWN_REPO_FACTS).dirty).toBe(false)
  })

  it('reads a rename, which uses the 2 prefix, as dirty', () => {
    expect(parseGitStatus('2 R. N... 100644 100644 100644 aaa bbb R100 new.ts\told.ts', UNKNOWN_REPO_FACTS).dirty)
      .toBe(true)
  })

  it('reads conflicts and untracked files', () => {
    const out = ['u UU N... 100644 100644 100644 100644 a b c d conflicted.ts', '? new-file.ts'].join('\n')
    expect(parseGitStatus(out, UNKNOWN_REPO_FACTS)).toMatchObject({ conflicts: true, untracked: true })
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


describe('checkRemote', () => {
  it('reports a commit the remote has and this checkout does not', async () => {
    const repo = fakeRepo({ status: TRACKING_MAIN })
    repo.setRemoteHead(REMOTE_SHA)
    const probe = new RepoProbe('/repo', repo.deps)
    await probe.status()

    expect(await probe.checkRemote()).toBe(true)
    expect((await probe.status())?.behind).toBe(true)
  })

  it('stays quiet when the remote is pointing at a commit we already have', async () => {
    const repo = fakeRepo({ status: TRACKING_MAIN })
    repo.setRemoteHead(REMOTE_SHA)
    repo.pull(REMOTE_SHA)
    const probe = new RepoProbe('/repo', repo.deps)
    await probe.status()

    expect(await probe.checkRemote()).toBe(false)
    expect((await probe.status())?.behind).toBe(false)
  })

  it('asks only about the branch this one tracks', async () => {
    const repo = fakeRepo({ status: '# branch.head wip\n# branch.upstream upstream/feature/x' })
    repo.setRemoteHead(REMOTE_SHA)
    const probe = new RepoProbe('/repo', repo.deps)
    await probe.status()
    await probe.checkRemote()

    expect(repo.remoteCalls).toEqual([['ls-remote', '--heads', 'upstream', 'feature/x']])
  })

  it('does not go to the network for a branch with no upstream', async () => {
    const repo = fakeRepo({ status: '# branch.head wip' })
    const probe = new RepoProbe('/repo', repo.deps)
    await probe.status()

    expect(await probe.checkRemote()).toBe(false)
    expect(repo.remoteCalls).toEqual([])
  })

  it('stops asking once it knows there is something to pull', async () => {
    const repo = fakeRepo({ status: TRACKING_MAIN })
    repo.setRemoteHead(REMOTE_SHA)
    const probe = new RepoProbe('/repo', repo.deps)
    await probe.status()
    await probe.checkRemote()
    expect(repo.remoteCalls).toHaveLength(1)

    await probe.checkRemote()
    await probe.checkRemote()

    // The badge is already lit; no answer could change it.
    expect(repo.remoteCalls).toHaveLength(1)
  })

  it('starts asking again once the pull has landed', async () => {
    const repo = fakeRepo({ status: TRACKING_MAIN })
    repo.setRemoteHead(REMOTE_SHA)
    const probe = new RepoProbe('/repo', repo.deps)
    await probe.status()
    await probe.checkRemote()

    repo.pull(REMOTE_SHA)
    expect((await probe.status())?.behind).toBe(false)

    await probe.checkRemote()
    expect(repo.remoteCalls).toHaveLength(2)
  })

  it('says nothing when the remote cannot be reached', async () => {
    const repo = fakeRepo({ status: TRACKING_MAIN })
    repo.setRemoteHead(null)
    const probe = new RepoProbe('/repo', repo.deps)
    await probe.status()

    // Offline is not the same as up to date.
    expect(await probe.checkRemote()).toBe(false)
    expect((await probe.status())?.behind).toBe(false)
  })

  it('keeps what git status already knew about being behind', async () => {
    const repo = fakeRepo({ status: `${TRACKING_MAIN}\n# branch.ab +0 -4` })
    const probe = new RepoProbe('/repo', repo.deps)

    expect((await probe.status())?.behind).toBe(true)
  })

  it('does not go to the network when a stale fetch already says we are behind', async () => {
    // The badge is lit off `# branch.ab`, from whenever the last fetch ran.
    // Asking the remote cannot light it any further.
    const repo = fakeRepo({ status: `${TRACKING_MAIN}\n# branch.ab +0 -17` })
    repo.setRemoteHead(REMOTE_SHA)
    const probe = new RepoProbe('/repo', repo.deps)
    await probe.status()

    expect(await probe.checkRemote()).toBe(false)
    expect(repo.remoteCalls).toEqual([])
  })

  it('reports no change on a second look that finds the same commit', async () => {
    const repo = fakeRepo({ status: TRACKING_MAIN })
    repo.setRemoteHead(REMOTE_SHA)
    repo.pull(REMOTE_SHA)
    const probe = new RepoProbe('/repo', repo.deps)
    await probe.status()

    expect(await probe.checkRemote()).toBe(false)
    expect(await probe.checkRemote()).toBe(false)
  })
})
