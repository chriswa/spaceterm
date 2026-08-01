import { describe, it, expect } from 'vitest'
import {
  mergeCursorStatusLine,
  mergeCursorHooks,
  mergeCodexHooks,
  isCodexHandlerCommand,
  CURSOR_HOOK_EVENTS,
  CODEX_HOOK_EVENTS
} from './agent-provisioning'

const HANDLER = '/home/u/.spaceterm/cursor-agent-plugin/scripts/hook-handler.sh'
const STATUSLINE = '/home/u/.spaceterm/cursor-agent-plugin/scripts/statusline-handler.sh'
const CODEX_HANDLER = '/home/u/.spaceterm/codex-agent-plugin/scripts/hook-handler.sh'

// These merges rewrite files the user owns — ~/.cursor/cli-config.json,
// ~/.cursor/hooks.json, ~/.codex/hooks.json. The invariant that matters is that
// they are additive: whatever else is in there survives, a previous Spaceterm
// entry is replaced rather than duplicated, and running twice is a no-op.

describe('mergeCursorStatusLine', () => {
  it('installs our statusLine into an empty config', () => {
    const { config, passthrough } = mergeCursorStatusLine(undefined, STATUSLINE)
    expect(config.statusLine).toMatchObject({ type: 'command', command: STATUSLINE })
    expect(config.version).toBe(1)
    expect(passthrough).toBeUndefined()
  })

  it('preserves unrelated config keys', () => {
    const { config } = mergeCursorStatusLine({ version: 3, model: 'auto', theme: 'dark' }, STATUSLINE)
    expect(config).toMatchObject({ version: 3, model: 'auto', theme: 'dark' })
  })

  it("parks the user's own statusLine so it is not destroyed", () => {
    const theirs = { type: 'command', command: '/usr/local/bin/my-statusline' }
    const { config, passthrough } = mergeCursorStatusLine({ statusLine: theirs }, STATUSLINE)

    expect(passthrough).toEqual(theirs)
    expect(config.statusLine).toMatchObject({ command: STATUSLINE })
  })

  it('does not park our own statusLine as if it were the user\'s', () => {
    // Otherwise the second launch would "preserve" our handler and start
    // chaining it to itself.
    const ours = { type: 'command', command: STATUSLINE }
    expect(mergeCursorStatusLine({ statusLine: ours }, STATUSLINE).passthrough).toBeUndefined()
  })

  it('recognises our handler from a previous install path', () => {
    const older = { type: 'command', command: '/other/src/cursor-agent-plugin/scripts/statusline-handler.sh' }
    expect(mergeCursorStatusLine({ statusLine: older }, STATUSLINE).passthrough).toBeUndefined()
  })

  it('is idempotent', () => {
    const once = mergeCursorStatusLine({ version: 1 }, STATUSLINE).config
    const twice = mergeCursorStatusLine(once, STATUSLINE).config
    expect(twice).toEqual(once)
  })

  it('recovers from a config that is not an object', () => {
    for (const junk of [null, 'nonsense', 42, ['a']]) {
      const { config } = mergeCursorStatusLine(junk, STATUSLINE)
      expect(config.statusLine).toMatchObject({ command: STATUSLINE })
    }
  })
})

describe('mergeCursorHooks', () => {
  it('registers our handler for every subscribed event', () => {
    const merged = mergeCursorHooks(undefined, HANDLER) as { hooks: Record<string, unknown[]> }
    for (const event of CURSOR_HOOK_EVENTS) {
      expect(merged.hooks[event]).toEqual([{ command: HANDLER, timeout: 5 }])
    }
  })

  it("keeps the user's own hooks and appends ours", () => {
    const theirs = { command: '/usr/local/bin/their-hook', timeout: 10 }
    const merged = mergeCursorHooks(
      { hooks: { stop: [theirs] } },
      HANDLER
    ) as { hooks: Record<string, unknown[]> }

    expect(merged.hooks.stop).toEqual([theirs, { command: HANDLER, timeout: 5 }])
  })

  it('replaces a previous Spaceterm entry rather than duplicating it', () => {
    const once = mergeCursorHooks(undefined, HANDLER)
    const twice = mergeCursorHooks(once, HANDLER) as { hooks: Record<string, unknown[]> }
    expect(twice.hooks.stop).toHaveLength(1)
  })

  it('is idempotent', () => {
    const once = mergeCursorHooks({ hooks: { stop: [{ command: '/theirs' }] } }, HANDLER)
    expect(mergeCursorHooks(once, HANDLER)).toEqual(once)
  })

  it('replaces our entry from an older install path', () => {
    const stale = { command: '/elsewhere/src/cursor-agent-plugin/scripts/hook-handler.sh', timeout: 5 }
    const merged = mergeCursorHooks({ hooks: { stop: [stale] } }, HANDLER) as { hooks: Record<string, unknown[]> }
    expect(merged.hooks.stop).toEqual([{ command: HANDLER, timeout: 5 }])
  })

  it('preserves unrelated top-level keys and events', () => {
    const merged = mergeCursorHooks(
      { version: 2, note: 'mine', hooks: { someOtherEvent: [{ command: '/x' }] } },
      HANDLER
    ) as { version: number; note: string; hooks: Record<string, unknown[]> }

    expect(merged.version).toBe(2)
    expect(merged.note).toBe('mine')
    expect(merged.hooks.someOtherEvent).toEqual([{ command: '/x' }])
  })

  it('recovers when hooks is the wrong shape', () => {
    for (const junk of [{ hooks: 'nope' }, { hooks: ['a'] }, { hooks: null }]) {
      const merged = mergeCursorHooks(junk, HANDLER) as { hooks: Record<string, unknown[]> }
      expect(merged.hooks.stop).toEqual([{ command: HANDLER, timeout: 5 }])
    }
  })

  it('recovers when an event holds something that is not an array', () => {
    const merged = mergeCursorHooks({ hooks: { stop: 'nope' } }, HANDLER) as { hooks: Record<string, unknown[]> }
    expect(merged.hooks.stop).toEqual([{ command: HANDLER, timeout: 5 }])
  })
})

describe('isCodexHandlerCommand', () => {
  it('recognises the installed path', () => {
    expect(isCodexHandlerCommand(CODEX_HANDLER)).toBe(true)
  })

  it('recognises a repo-relative path from a dev install', () => {
    expect(isCodexHandlerCommand('/repo/src/codex-agent-plugin/scripts/hook-handler.sh')).toBe(true)
  })

  it('does not claim an unrelated command', () => {
    expect(isCodexHandlerCommand('/usr/local/bin/their-hook')).toBe(false)
    expect(isCodexHandlerCommand(undefined)).toBe(false)
    expect(isCodexHandlerCommand(42)).toBe(false)
  })
})

describe('mergeCodexHooks', () => {
  it('registers a matcher group for every subscribed event', () => {
    const merged = mergeCodexHooks(undefined, CODEX_HANDLER) as { hooks: Record<string, unknown[]> }
    for (const event of CODEX_HOOK_EVENTS) {
      expect(merged.hooks[event]).toHaveLength(1)
      expect(merged.hooks[event][0]).toMatchObject({
        matcher: '*',
        hooks: [{ type: 'command', command: CODEX_HANDLER }]
      })
    }
  })

  it('clamps the SessionEnd timeout, which Codex caps at 3s', () => {
    const merged = mergeCodexHooks(undefined, CODEX_HANDLER) as {
      hooks: Record<string, Array<{ hooks: Array<{ timeout: number }> }>>
    }
    expect(merged.hooks.SessionEnd[0].hooks[0].timeout).toBe(3)
    expect(merged.hooks.Stop[0].hooks[0].timeout).toBe(5)
  })

  it("keeps the user's own matcher groups", () => {
    const theirs = { matcher: 'Bash', hooks: [{ type: 'command', command: '/theirs' }] }
    const merged = mergeCodexHooks({ hooks: { Stop: [theirs] } }, CODEX_HANDLER) as {
      hooks: Record<string, unknown[]>
    }
    expect(merged.hooks.Stop[0]).toEqual(theirs)
    expect(merged.hooks.Stop).toHaveLength(2)
  })

  it('replaces our group rather than duplicating it', () => {
    const once = mergeCodexHooks(undefined, CODEX_HANDLER)
    const twice = mergeCodexHooks(once, CODEX_HANDLER) as { hooks: Record<string, unknown[]> }
    expect(twice.hooks.Stop).toHaveLength(1)
  })

  it('is idempotent', () => {
    const once = mergeCodexHooks({ hooks: { Stop: [{ matcher: 'x', hooks: [{ command: '/theirs' }] }] } }, CODEX_HANDLER)
    expect(mergeCodexHooks(once, CODEX_HANDLER)).toEqual(once)
  })

  it('identifies our group by any hook inside it, not just the first', () => {
    const mixed = {
      matcher: '*',
      hooks: [{ type: 'command', command: '/theirs' }, { type: 'command', command: CODEX_HANDLER }]
    }
    const merged = mergeCodexHooks({ hooks: { Stop: [mixed] } }, CODEX_HANDLER) as {
      hooks: Record<string, unknown[]>
    }
    expect(merged.hooks.Stop).toHaveLength(1)
  })

  it('preserves unrelated events and top-level keys', () => {
    const merged = mergeCodexHooks(
      { profile: 'mine', hooks: { SomeOtherEvent: [{ matcher: 'x', hooks: [] }] } },
      CODEX_HANDLER
    ) as { profile: string; hooks: Record<string, unknown[]> }

    expect(merged.profile).toBe('mine')
    expect(merged.hooks.SomeOtherEvent).toHaveLength(1)
  })

  it('recovers from a malformed document', () => {
    for (const junk of [null, 'nonsense', ['a'], { hooks: 7 }]) {
      const merged = mergeCodexHooks(junk, CODEX_HANDLER) as { hooks: Record<string, unknown[]> }
      expect(merged.hooks.Stop).toHaveLength(1)
    }
  })
})

describe('the two agents do not claim each other entries', () => {
  it('a Cursor hook is left alone by the Codex merge', () => {
    const cursorEntry = { matcher: '*', hooks: [{ command: HANDLER }] }
    const merged = mergeCodexHooks({ hooks: { Stop: [cursorEntry] } }, CODEX_HANDLER) as {
      hooks: Record<string, unknown[]>
    }
    expect(merged.hooks.Stop).toContainEqual(cursorEntry)
  })

  it('a Codex hook is left alone by the Cursor merge', () => {
    const codexEntry = { command: CODEX_HANDLER, timeout: 5 }
    const merged = mergeCursorHooks({ hooks: { stop: [codexEntry] } }, HANDLER) as {
      hooks: Record<string, unknown[]>
    }
    expect(merged.hooks.stop).toContainEqual(codexEntry)
  })
})
