import { describe, expect, it } from 'vitest'
import { INHERITED_AGENT_SESSION_VARS, scrubInheritedAgentEnv } from './spawn-env'

describe('scrubInheritedAgentEnv', () => {
  it('drops every agent session marker and keeps the rest', () => {
    const env: Record<string, string> = { HOME: '/h', PATH: '/bin', SHELL: '/bin/zsh' }
    for (const key of INHERITED_AGENT_SESSION_VARS) env[key] = 'x'
    const out = scrubInheritedAgentEnv(env)
    for (const key of INHERITED_AGENT_SESSION_VARS) expect(out).not.toHaveProperty(key)
    expect(out).toEqual({ HOME: '/h', PATH: '/bin', SHELL: '/bin/zsh' })
  })

  it('forwards user-set agent configuration', () => {
    const out = scrubInheritedAgentEnv({
      CLAUDE_CONFIG_DIR: '/cfg',
      CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1',
      CLAUDECODE: '1',
    })
    expect(out).toEqual({ CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1' })
  })

  it('does not mutate its input and skips undefined entries', () => {
    const env = { A: 'a', B: undefined, CLAUDE_PID: '1' }
    const out = scrubInheritedAgentEnv(env)
    expect(out).toEqual({ A: 'a' })
    expect(env.CLAUDE_PID).toBe('1')
  })
})
