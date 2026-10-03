import { describe, expect, it } from 'vitest'
import { asNodeId } from '../../shared/ids'
import { SessionForks, type ForkLaunch, type SessionForkDeps } from './session-fork'

const KEVIN = asNodeId('11111111-0000-4000-8000-000000000000')
const LAUNCH: ForkLaunch = {
  cwd: '/src/fluids', command: 'claude', args: ['--plugin-dir', '/p', '--settings', '{}', '--dangerously-skip-permissions'], env: { PATH: '/bin' },
}

function harness(opts: { launch?: ForkLaunch | null } = {}) {
  const runs: Array<{ launch: ForkLaunch; args: string[]; prompt: string }> = []
  let next = 0
  const deps: SessionForkDeps = {
    run: async (l, args, prompt) => {
      runs.push({ launch: l, args, prompt })
      const forking = args.includes('--fork-session')
      return { sessionId: forking ? `fork-${++next}` : args[args.indexOf('--resume') + 1], result: `answer to ${prompt}`, isError: false }
    },
  }
  let current: ForkLaunch | undefined = opts.launch === null ? undefined : (opts.launch ?? LAUNCH)
  const forks = new SessionForks(() => current, deps)
  return { forks, runs, setLaunch: (l: ForkLaunch | undefined) => { current = l } }
}

describe('SessionForks', () => {
  it('forks with the surface\'s own command line, adding only the print and fork flags', async () => {
    const h = harness()
    const result = await h.forks.fork({ nodeId: KEVIN, sessionId: 'kevin-session', prompt: 'how many litres?' })
    expect(result).toEqual({ forkId: 'fork-1', answer: 'answer to how many litres?' })
    expect(h.runs[0].launch).toBe(LAUNCH)
    expect(h.runs[0].args).toEqual(['-p', '--resume', 'kevin-session', '--fork-session', '--output-format', 'json'])
    // No profile of its own: nothing that would change the cached prompt prefix.
    expect(h.runs[0].args.join(' ')).not.toMatch(/--model|--tools|--system-prompt|--setting-sources/)
  })

  it('resumes a follow-up as the fork was made, without forking again', async () => {
    const h = harness()
    const { forkId } = await h.forks.fork({ nodeId: KEVIN, sessionId: 'kevin-session', prompt: 'q1' })
    h.setLaunch({ ...LAUNCH, args: ['--changed'] })
    await h.forks.ask({ forkId, prompt: 'q2' })
    expect(h.runs[1].launch).toBe(LAUNCH)
    expect(h.runs[1].args).toEqual(['-p', '--resume', forkId, '--output-format', 'json'])
  })

  it('refuses surfaces it cannot launch and forks it did not make', async () => {
    const h = harness({ launch: null })
    await expect(h.forks.fork({ nodeId: KEVIN, sessionId: 's', prompt: 'q' })).rejects.toThrow(/not a live Claude surface/)
    await expect(h.forks.ask({ forkId: 'stranger', prompt: 'q' })).rejects.toThrow(/not one this server made/)
  })
})
