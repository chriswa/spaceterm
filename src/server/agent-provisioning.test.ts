import { describe, it, expect } from 'vitest'
import { codexConfigOverrides, CODEX_HOOK_EVENTS } from './agent-provisioning'

const CODEX_HANDLER = '/home/u/.spaceterm/codex-agent-plugin/scripts/hook-handler.sh'
const MCP = '/repo/src/claude-code-plugin/mcp-server/run.sh'

describe('codexConfigOverrides', () => {
  const overrides = codexConfigOverrides(CODEX_HANDLER, MCP)

  it('subscribes the handler to every event, as a matcher group', () => {
    for (const event of CODEX_HOOK_EVENTS) {
      expect(overrides).toContain(
        `hooks.${event}=[{matcher="*",hooks=[{type="command",command="${CODEX_HANDLER}",timeout=${event === 'SessionEnd' ? 3 : 5}}]}]`
      )
    }
  })

  it('clamps the SessionEnd timeout, which Codex caps at 3s', () => {
    expect(overrides.find((o) => o.startsWith('hooks.SessionEnd='))).toContain('timeout=3')
    expect(overrides.find((o) => o.startsWith('hooks.Stop='))).toContain('timeout=5')
  })

  it('registers the MCP server', () => {
    expect(overrides).toContain(`mcp_servers.spaceterm.command="${MCP}"`)
    expect(overrides).toContain('mcp_servers.spaceterm.args=[]')
  })

  it('quotes a path that needs it as a valid TOML string', () => {
    const [first] = codexConfigOverrides('/Users/a "b"/h.sh', MCP)
    expect(first).toContain('command="/Users/a \\"b\\"/h.sh"')
  })
})
