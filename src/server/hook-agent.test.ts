import { homedir } from 'os'
import * as path from 'path'
import { describe, expect, it } from 'vitest'
import { hookPayloadAgentType, isForeignAgentHook } from './hook-agent'

const claudePath = path.join(homedir(), '.claude', 'projects', '-Users-me-proj', 'c91bbff6.jsonl')
const cursorPath = path.join(homedir(), '.cursor', 'projects', 'Users-me-proj', 'agent-transcripts', '6633b0bc', '6633b0bc.jsonl')
const codexPath = path.join(homedir(), '.codex', 'sessions', '2026', '08', '18', 'rollout-2026-08-18T10-21-15-01a015e4.jsonl')

describe('hookPayloadAgentType', () => {
  it('reads the agent off a Claude SessionStart', () => {
    expect(hookPayloadAgentType({
      hook_event_name: 'SessionStart', session_id: 'c91bbff6', source: 'resume', transcript_path: claudePath,
    })).toBe('claude')
  })

  it('reads the agent off a Codex SessionStart despite its Claude-shaped keys', () => {
    // Codex carries session_id + transcript_path just like Claude; only the
    // transcript root tells them apart.
    expect(hookPayloadAgentType({
      hook_event_name: 'SessionStart', session_id: '01a015e4', source: 'startup', transcript_path: codexPath,
    })).toBe('codex')
  })

  it('reads the agent off a Cursor turn hook by its transcript root', () => {
    expect(hookPayloadAgentType({
      hook_event_name: 'PreToolUse', session_id: '6633b0bc', transcript_path: cursorPath,
    })).toBe('cursor')
  })

  it('falls back to cursor_version when Cursor omits the path', () => {
    // Cursor's own SessionStart reports transcript_path: null.
    expect(hookPayloadAgentType({
      hook_event_name: 'SessionStart', session_id: '6633b0bc', source: 'startup',
      transcript_path: null, cursor_version: '1.2.3', conversation_id: '6633b0bc',
    })).toBe('cursor')
  })

  it('is undefined for a shape too generic to attribute', () => {
    expect(hookPayloadAgentType({ hook_event_name: 'SessionStart', session_id: 'x' })).toBeUndefined()
    expect(hookPayloadAgentType(undefined)).toBeUndefined()
  })
})

describe('isForeignAgentHook', () => {
  const cursorSessionStart = {
    hook_event_name: 'SessionStart', session_id: '6633b0bc', source: 'startup',
    transcript_path: null, cursor_version: '1.2.3', conversation_id: '6633b0bc',
  }

  it('flags a Cursor sub-agent hook arriving on a Claude surface', () => {
    // The reported bug: a nested cursor-agent run inside a Claude terminal.
    expect(isForeignAgentHook(cursorSessionStart, 'claude')).toBe(true)
  })

  it('accepts a Claude hook on a Claude surface', () => {
    expect(isForeignAgentHook({
      hook_event_name: 'SessionStart', session_id: 'c91bbff6', transcript_path: claudePath,
    }, 'claude')).toBe(false)
  })

  it('accepts a Cursor hook on a Cursor surface', () => {
    expect(isForeignAgentHook(cursorSessionStart, 'cursor')).toBe(false)
  })

  it('does not block when the surface agent is unknown', () => {
    expect(isForeignAgentHook(cursorSessionStart, undefined)).toBe(false)
  })

  it('does not block an unclassifiable hook', () => {
    expect(isForeignAgentHook({ hook_event_name: 'SessionStart', session_id: 'x' }, 'claude')).toBe(false)
  })
})
