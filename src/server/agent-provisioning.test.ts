import { describe, it, expect } from 'vitest'
import {
  codexConfigOverrides,
  withoutCursorHooks,
  withoutCodexHooks,
  isCodexHandlerCommand,
  CODEX_HOOK_EVENTS
} from './agent-provisioning'

const HANDLER = '/home/u/.spaceterm/cursor-agent-plugin/scripts/hook-handler.sh'
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

// The retirements rewrite files the user owns — ~/.cursor/hooks.json and
// ~/.codex/hooks.json — to take back what older versions merged in. The
// invariant that matters: only Spaceterm's entries go, and a file with none of
// them is reported unchanged so it is never rewritten.

describe('withoutCursorHooks', () => {
  const ours = { command: HANDLER, timeout: 5 }
  const theirs = { command: '/usr/local/bin/their-hook' }

  it('removes our handler and keeps theirs', () => {
    const { config, changed } = withoutCursorHooks({ version: 1, hooks: { stop: [theirs, ours] } }, HANDLER)
    expect(changed).toBe(true)
    expect(config).toEqual({ version: 1, hooks: { stop: [theirs] } })
  })

  it('drops an event that only we subscribed to', () => {
    const { config } = withoutCursorHooks({ version: 1, hooks: { stop: [ours], preToolUse: [theirs] } }, HANDLER)
    expect(config).toEqual({ version: 1, hooks: { preToolUse: [theirs] } })
  })

  it('recognises our handler from an older install path', () => {
    const old = { command: '/repo/src/cursor-agent-plugin/scripts/hook-handler.sh' }
    expect(withoutCursorHooks({ hooks: { stop: [old] } }, HANDLER).changed).toBe(true)
  })

  it('leaves a file with nothing of ours unchanged', () => {
    const doc = { version: 1, hooks: { stop: [theirs], weird: 'not an array' }, other: true }
    const { config, changed } = withoutCursorHooks(doc, HANDLER)
    expect(changed).toBe(false)
    expect(config).toBe(doc)
  })

  it('leaves a malformed document alone', () => {
    for (const junk of [null, 'nonsense', ['a'], { hooks: 7 }]) {
      expect(withoutCursorHooks(junk, HANDLER).changed).toBe(false)
    }
  })
})

describe('withoutCodexHooks', () => {
  const ours = { matcher: '*', hooks: [{ type: 'command', command: CODEX_HANDLER, timeout: 5 }] }
  const theirs = { matcher: 'Bash', hooks: [{ type: 'command', command: '/theirs' }] }

  it('removes our matcher group and keeps theirs, and unrelated keys', () => {
    const { config, changed } = withoutCodexHooks({ profile: 'mine', hooks: { Stop: [theirs, ours] } })
    expect(changed).toBe(true)
    expect(config).toEqual({ profile: 'mine', hooks: { Stop: [theirs] } })
  })

  it('identifies our group by any hook inside it, not just the first', () => {
    const mixed = { matcher: '*', hooks: [{ command: '/theirs' }, { command: CODEX_HANDLER }] }
    expect(withoutCodexHooks({ hooks: { Stop: [mixed] } })).toEqual({ config: { hooks: {} }, changed: true })
  })

  it('leaves a file with nothing of ours unchanged', () => {
    const doc = { hooks: { Stop: [theirs] } }
    expect(withoutCodexHooks(doc)).toEqual({ config: doc, changed: false })
  })
})

describe('isCodexHandlerCommand', () => {
  it('recognises the installed path', () => {
    expect(isCodexHandlerCommand(CODEX_HANDLER)).toBe(true)
  })

  it('recognises a repo-relative path from a dev install', () => {
    expect(isCodexHandlerCommand('/repo/src/codex-agent-plugin/scripts/hook-handler.sh')).toBe(true)
  })

  it('recognises a handler under a SPACETERM_HOME elsewhere, as the e2e suite uses', () => {
    expect(isCodexHandlerCommand('/var/folders/x/T/spaceterm-e2e-abc/codex-agent-plugin/scripts/hook-handler.sh')).toBe(true)
  })

  it('does not claim an unrelated command', () => {
    expect(isCodexHandlerCommand('/usr/local/bin/their-hook')).toBe(false)
    expect(isCodexHandlerCommand(undefined)).toBe(false)
    expect(isCodexHandlerCommand(42)).toBe(false)
  })
})

describe('the two agents do not claim each other entries', () => {
  it('a Cursor hook is left alone by the Codex retirement', () => {
    const cursorEntry = { matcher: '*', hooks: [{ command: HANDLER }] }
    expect(withoutCodexHooks({ hooks: { Stop: [cursorEntry] } }).changed).toBe(false)
  })

  it('a Codex hook is left alone by the Cursor retirement', () => {
    expect(withoutCursorHooks({ hooks: { stop: [{ command: CODEX_HANDLER }] } }, HANDLER).changed).toBe(false)
  })
})
