import { describe, it, expect } from 'vitest'
import {
  createAgentDrivers,
  driverFor,
  shellQuote,
  type AgentDriver,
  type AgentProvisioning
} from './agent-drivers'
import { AGENT_TYPES, type AgentType } from '../shared/agent-type'

/** Records provisioning calls; returns fixed paths so argv is deterministic. */
function fakeProvisioning(): AgentProvisioning & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    claudePluginDir: () => { calls.push('claudePluginDir'); return '/plugins/claude' },
    cursorPluginDir: () => { calls.push('cursorPluginDir'); return '/plugins/cursor' },
    prepareCodex: () => { calls.push('prepareCodex') }
  }
}

function drivers(): Record<AgentType, AgentDriver> {
  return createAgentDrivers(fakeProvisioning())
}

/** Index of `flag` in argv, or -1. */
function at(args: string[], flag: string): number {
  return args.indexOf(flag)
}

describe('the registry covers every agent type', () => {
  it('has a driver for each', () => {
    const d = drivers()
    for (const type of AGENT_TYPES) {
      expect(d[type]).toBeDefined()
      expect(d[type].type).toBe(type)
    }
  })

  it('gives each a label', () => {
    const d = drivers()
    expect(AGENT_TYPES.map((t) => d[t].label)).toEqual(['Claude', 'Cursor', 'Codex'])
  })
})

describe('driverFor', () => {
  it('resolves a known agent type', () => {
    expect(driverFor(drivers(), 'codex').type).toBe('codex')
  })

  it('treats an unrecorded agentType as Claude — surfaces predating the field', () => {
    expect(driverFor(drivers(), undefined).type).toBe('claude')
  })
})

describe('capabilities', () => {
  it('marks only Claude as using Claude-shaped transcripts', () => {
    const d = drivers()
    expect(d.claude.capabilities.claudeTranscript).toBe(true)
    expect(d.cursor.capabilities.claudeTranscript).toBe(false)
    expect(d.codex.capabilities.claudeTranscript).toBe(false)
  })

  it('marks only Claude as requiring a resumable session to revive', () => {
    const d = drivers()
    expect(d.claude.capabilities.requiresResumableSession).toBe(true)
    expect(d.cursor.capabilities.requiresResumableSession).toBe(false)
    expect(d.codex.capabilities.requiresResumableSession).toBe(false)
  })

  it('records how each agent forks', () => {
    const d = drivers()
    expect(d.claude.capabilities.forkStrategy).toBe('transcript-clone')
    expect(d.cursor.capabilities.forkStrategy).toBe('none')
    expect(d.codex.capabilities.forkStrategy).toBe('native')
  })
})

describe('claude driver', () => {
  it('always passes the plugin dir, status line and permission bypass', () => {
    const options = drivers().claude.buildCreateOptions({})

    expect(options.command).toBe('claude')
    expect(options.args).toContain('--dangerously-skip-permissions')
    expect(options.args).toContain('/plugins/claude')
    const settings = options.args![at(options.args!, '--settings') + 1]
    expect(JSON.parse(settings)).toMatchObject({
      statusLine: { type: 'command', command: '/plugins/claude/scripts/statusline-handler.sh' }
    })
  })

  it('withholds EndConversation, which self-terminates nothing on a surface', () => {
    const options = drivers().claude.buildCreateOptions({})
    expect(options.args![at(options.args!, '--disallowed-tools') + 1]).toBe('EndConversation')
  })

  it('never leaves --disallowed-tools last, where it would eat an extra arg', () => {
    // The flag is variadic: whatever follows it is consumed as another tool name
    // until the next `--flag`. A bare extraArgs value landing there would be
    // silently swallowed instead of reaching claude.
    const options = drivers().claude.buildCreateOptions({ extraArgs: ['bare-value'] })
    const args = options.args!
    expect(args[at(args, '--disallowed-tools') + 2]).toMatch(/^--/)
  })

  it('resumes with -r', () => {
    const options = drivers().claude.buildCreateOptions({ resumeSessionId: 'sess-1' })
    expect(options.args![at(options.args!, '-r') + 1]).toBe('sess-1')
  })

  it('passes a plain prompt after a -- separator', () => {
    const options = drivers().claude.buildCreateOptions({ prompt: 'do the thing' })
    expect(options.args!.slice(-2)).toEqual(['--', 'do the thing'])
  })

  it('passes the cwd through as the PTY working directory', () => {
    // Claude is launched *in* the directory, unlike Cursor and Codex which take
    // it as an argv entry — so `~` is left for the shell to expand.
    const options = drivers().claude.buildCreateOptions({ cwd: '~/projects/app' })
    expect(options.cwd).toBe('~/projects/app')
  })

  it('places extra CLI args before the resume flag', () => {
    const options = drivers().claude.buildCreateOptions({
      resumeSessionId: 'sess-1',
      extraArgs: ['--model', 'opus']
    })
    expect(at(options.args!, '--model')).toBeLessThan(at(options.args!, '-r'))
  })

  it('wraps in a shell script when the prompt is an appended system prompt', () => {
    const options = drivers().claude.buildCreateOptions({
      prompt: 'be terse',
      appendSystemPrompt: true
    })

    expect(options.command).toBe('/bin/sh')
    expect(options.args![0]).toBe('-c')
    const script = options.args![1]
    // The banner must not be echoed twice by the PTY line discipline.
    expect(script).toContain('stty -echo')
    expect(script).toContain('stty echo')
    expect(script).toContain('exec ')
    expect(script).toContain('--append-system-prompt')
  })

  it('quotes a prompt containing a single quote so the script stays valid', () => {
    const options = drivers().claude.buildCreateOptions({
      prompt: "don't break",
      appendSystemPrompt: true
    })
    // Naive interpolation would terminate the shell string at the apostrophe.
    expect(options.args![1]).toContain("'\\''")
  })

  it('does not build a script when a prompt is given without appendSystemPrompt', () => {
    const options = drivers().claude.buildCreateOptions({ prompt: 'hello' })
    expect(options.command).toBe('claude')
  })
})

describe('cursor driver', () => {
  it('passes the trust and yolo flags', () => {
    const options = drivers().cursor.buildCreateOptions({})

    expect(options.command).toBe('agent')
    expect(options.args).toEqual(expect.arrayContaining(['--yolo', '--trust', '--approve-mcps']))
    expect(options.args).toContain('/plugins/cursor')
  })

  it('takes the workspace as an argv entry, with ~ expanded', () => {
    // Cursor does not run through a shell, so a literal ~ would not resolve.
    const options = drivers().cursor.buildCreateOptions({ cwd: '~/work' })
    expect(options.args![at(options.args!, '--workspace') + 1]).not.toContain('~')
    expect(options.cwd).not.toContain('~')
  })

  it('resumes with --resume=<id>', () => {
    const options = drivers().cursor.buildCreateOptions({ resumeSessionId: 'chat-9' })
    expect(options.args).toContain('--resume=chat-9')
  })

  it('passes the prompt last', () => {
    const options = drivers().cursor.buildCreateOptions({ resumeSessionId: 'c1', prompt: 'go' })
    expect(options.args![options.args!.length - 1]).toBe('go')
  })

  it('ignores forkSessionId, which it cannot honour', () => {
    const options = drivers().cursor.buildCreateOptions({ forkSessionId: 'nope' })
    expect(options.args).not.toContain('nope')
  })
})

describe('codex driver', () => {
  it('passes the sandbox and hook-trust bypasses', () => {
    const options = drivers().codex.buildCreateOptions({})

    expect(options.command).toBe('codex')
    expect(options.args).toEqual(expect.arrayContaining([
      '--dangerously-bypass-hook-trust',
      '--dangerously-bypass-approvals-and-sandbox'
    ]))
    expect(options.args![at(options.args!, '-p') + 1]).toBe('spaceterm')
  })

  it('takes the working dir as -C, with ~ expanded', () => {
    const options = drivers().codex.buildCreateOptions({ cwd: '~/work' })
    expect(options.args![at(options.args!, '-C') + 1]).not.toContain('~')
  })

  it('puts the resume subcommand first and the session id after every option', () => {
    // `codex resume [OPTIONS] [SESSION_ID] [PROMPT]` — order is load-bearing.
    const options = drivers().codex.buildCreateOptions({
      resumeSessionId: 'sess-7',
      extraArgs: ['--model', 'gpt-5']
    })

    expect(options.args![0]).toBe('resume')
    expect(at(options.args!, 'sess-7')).toBeGreaterThan(at(options.args!, '--model'))
    expect(at(options.args!, 'sess-7')).toBeGreaterThan(at(options.args!, '-p'))
  })

  it('uses the fork subcommand when forking', () => {
    const options = drivers().codex.buildCreateOptions({ forkSessionId: 'sess-7' })
    expect(options.args![0]).toBe('fork')
    expect(options.args).toContain('sess-7')
  })

  it('prefers fork over resume when both are given', () => {
    const options = drivers().codex.buildCreateOptions({
      forkSessionId: 'fork-me',
      resumeSessionId: 'resume-me'
    })
    expect(options.args![0]).toBe('fork')
    expect(options.args).not.toContain('resume-me')
  })

  it('appends the prompt after the session id', () => {
    const options = drivers().codex.buildCreateOptions({ resumeSessionId: 'sess-7', prompt: 'go' })
    expect(options.args![options.args!.length - 1]).toBe('go')
    expect(at(options.args!, 'sess-7')).toBeLessThan(at(options.args!, 'go'))
  })

  it('starts a fresh session with no subcommand', () => {
    const options = drivers().codex.buildCreateOptions({})
    expect(options.args![0]).not.toBe('resume')
    expect(options.args![0]).not.toBe('fork')
  })
})

describe('provisioning', () => {
  it('runs only for the agent being launched', () => {
    const p = fakeProvisioning()
    createAgentDrivers(p).codex.buildCreateOptions({})
    expect(p.calls).toEqual(['prepareCodex'])
  })

  it('is consulted for the plugin directory each launch, so a re-provision is picked up', () => {
    const p = fakeProvisioning()
    const d = createAgentDrivers(p)
    d.cursor.buildCreateOptions({})
    d.cursor.buildCreateOptions({})
    expect(p.calls).toEqual(['cursorPluginDir', 'cursorPluginDir'])
  })
})

describe('every driver tolerates an empty spec', () => {
  it.each(AGENT_TYPES)('%s builds a runnable command line', (type) => {
    const options = drivers()[type].buildCreateOptions({})
    expect(options.command).toBeTruthy()
    expect(Array.isArray(options.args)).toBe(true)
  })

  it.each(AGENT_TYPES)('%s ignores spec fields it does not use', (type) => {
    // The registry's contract: one spec shape, each driver takes what it needs.
    expect(() =>
      drivers()[type].buildCreateOptions({
        cwd: '/w',
        prompt: 'p',
        resumeSessionId: 'r',
        forkSessionId: 'f',
        appendSystemPrompt: true,
        extraArgs: ['-x']
      })
    ).not.toThrow()
  })

  it.each(AGENT_TYPES)('%s passes extra CLI args through', (type) => {
    const options = drivers()[type].buildCreateOptions({ extraArgs: ['--flag', 'value'] })
    expect(options.args).toEqual(expect.arrayContaining(['--flag', 'value']))
  })
})

describe('shellQuote', () => {
  it('wraps a plain string', () => {
    expect(shellQuote('hello')).toBe("'hello'")
  })

  it('escapes embedded single quotes', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'")
  })

  it('leaves other shell metacharacters inert inside the quotes', () => {
    expect(shellQuote('$(rm -rf /)')).toBe("'$(rm -rf /)'")
  })
})
