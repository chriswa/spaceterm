import { describe, it, expect } from 'vitest'
import {
  agentSessionIdFromPayload,
  peekAgentSessionIdFromHookLog,
  resolveNonClaudeResumeId,
  findValidClaudeSession,
  lastAgentSessionId,
  type ResumableSurface,
  type ResumeTargetDeps
} from './resume-target'
import { asClaudeSessionId, asNodeId, asPtySessionId, type ClaudeSessionId, type PtySessionId } from '../shared/ids'

const cid = (s: string): ClaudeSessionId => asClaudeSessionId(s)
const history = (...ids: string[]) => ids.map((claudeSessionId) => ({ claudeSessionId: cid(claudeSessionId) }))

/** A hook-log line, as the shell handlers write them. */
function hookLine(hookType: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ hookType, payload })
}

interface FakeConfig {
  /** Transcripts present on disk, as `${cwd}::${sessionId}`. */
  transcripts?: string[]
  /** Hook log lines per surface id. */
  logs?: Record<string, string[]>
}

function deps(config: FakeConfig = {}): ResumeTargetDeps & { reads: string[] } {
  const present = new Set(config.transcripts ?? [])
  const logs = config.logs ?? {}
  const reads: string[] = []
  return {
    reads,
    transcriptExists: (cwd, id) => present.has(`${cwd}::${id}`),
    readHookLog: (surfaceId) => { reads.push(surfaceId); return logs[surfaceId] ?? [] }
  }
}

describe('lastAgentSessionId', () => {
  it('returns the newest entry', () => {
    expect(lastAgentSessionId(history('a', 'b', 'c'))).toBe('c')
  })

  it('returns undefined for an empty history', () => {
    expect(lastAgentSessionId([])).toBeUndefined()
  })
})

describe('agentSessionIdFromPayload', () => {
  it('reads Claude’s session_id', () => {
    expect(agentSessionIdFromPayload({ session_id: 'abc' })).toBe('abc')
  })

  it('reads Cursor’s conversation_id', () => {
    expect(agentSessionIdFromPayload({ conversation_id: 'xyz' })).toBe('xyz')
  })

  it('prefers session_id when a payload somehow carries both', () => {
    expect(agentSessionIdFromPayload({ session_id: 'a', conversation_id: 'b' })).toBe('a')
  })

  it('returns the empty string, not undefined, when there is nothing', () => {
    // The ingest path treats '' as "nothing recorded" throughout; returning
    // undefined here would make half the call sites wrong.
    expect(agentSessionIdFromPayload(undefined)).toBe('')
    expect(agentSessionIdFromPayload({})).toBe('')
  })

  it('ignores empty strings and non-strings', () => {
    expect(agentSessionIdFromPayload({ session_id: '' })).toBe('')
    expect(agentSessionIdFromPayload({ session_id: 42 })).toBe('')
    expect(agentSessionIdFromPayload({ conversation_id: null })).toBe('')
  })
})

describe('peekAgentSessionIdFromHookLog', () => {
  const SURFACE = asPtySessionId('pty-1')

  it('returns the newest turn-level id', () => {
    const d = deps({ logs: { [SURFACE]: [
      hookLine('UserPromptSubmit', { session_id: 'old' }),
      hookLine('Stop', { session_id: 'new' })
    ] } })
    expect(peekAgentSessionIdFromHookLog(SURFACE, d)).toBe('new')
  })

  it('accepts every turn-level hook kind', () => {
    for (const kind of ['UserPromptSubmit', 'Stop', 'status-line', 'SessionStart']) {
      const d = deps({ logs: { [SURFACE]: [hookLine(kind, { session_id: 'found' })] } })
      expect(peekAgentSessionIdFromHookLog(SURFACE, d), kind).toBe('found')
    }
  })

  it('skips PreToolUse, which carries subagent conversation ids', () => {
    // Resuming one of those drops the user into a subagent's transcript rather
    // than their own conversation.
    const d = deps({ logs: { [SURFACE]: [
      hookLine('Stop', { session_id: 'main' }),
      hookLine('PreToolUse', { session_id: 'subagent' })
    ] } })
    expect(peekAgentSessionIdFromHookLog(SURFACE, d)).toBe('main')
  })

  it('reads the `type` field too, which some handlers write instead of hookType', () => {
    const d = deps({ logs: { [SURFACE]: [JSON.stringify({ type: 'status-line', payload: { conversation_id: 'c1' } })] } })
    expect(peekAgentSessionIdFromHookLog(SURFACE, d)).toBe('c1')
  })

  it('skips a truncated final line rather than giving up on the log', () => {
    // The log is appended to by a shell script that can be killed mid-write,
    // so a half-written last line is normal, not corruption.
    const d = deps({ logs: { [SURFACE]: [
      hookLine('Stop', { session_id: 'good' }),
      '{"hookType":"Stop","payl'
    ] } })
    expect(peekAgentSessionIdFromHookLog(SURFACE, d)).toBe('good')
  })

  it('skips blank lines', () => {
    const d = deps({ logs: { [SURFACE]: [hookLine('Stop', { session_id: 'good' }), '', '  '] } })
    expect(peekAgentSessionIdFromHookLog(SURFACE, d)).toBe('good')
  })

  it('skips a turn-level entry whose payload has no id', () => {
    const d = deps({ logs: { [SURFACE]: [
      hookLine('Stop', { session_id: 'good' }),
      hookLine('Stop', { cwd: '/somewhere' })
    ] } })
    expect(peekAgentSessionIdFromHookLog(SURFACE, d)).toBe('good')
  })

  it('returns undefined when there is no log at all', () => {
    expect(peekAgentSessionIdFromHookLog(SURFACE, deps())).toBeUndefined()
  })
})

describe('resolveNonClaudeResumeId', () => {
  const NODE = asNodeId('node-1')
  const PTY: PtySessionId = asPtySessionId('pty-current')

  function surface(overrides: Partial<ResumableSurface> = {}): ResumableSurface {
    return { id: NODE, sessionId: PTY, ...overrides }
  }

  it('prefers a live session id over everything else', () => {
    const d = deps({ logs: { [PTY]: [hookLine('Stop', { session_id: 'from-log' })] } })
    expect(resolveNonClaudeResumeId(surface({ claudeSessionHistory: history('from-history') }), cid('live'), d))
      .toBe('live')
  })

  it('falls back to the current surface’s hook log', () => {
    const d = deps({ logs: { [PTY]: [hookLine('Stop', { conversation_id: 'from-log' })] } })
    expect(resolveNonClaudeResumeId(surface(), null, d)).toBe('from-log')
  })

  it('then probes the log named after the node id', () => {
    // Hook logs are named after the pty that wrote them, and a terminal's
    // first pty session id IS its node id — so this reaches the log from
    // before the terminal was ever restarted.
    const d = deps({ logs: { [NODE]: [hookLine('Stop', { session_id: 'from-original-log' })] } })
    expect(resolveNonClaudeResumeId(surface(), null, d)).toBe('from-original-log')
    expect(d.reads).toEqual([PTY, NODE])
  })

  it('prefers the current log over the original one', () => {
    const d = deps({ logs: {
      [PTY]: [hookLine('Stop', { session_id: 'current' })],
      [NODE]: [hookLine('Stop', { session_id: 'original' })]
    } })
    expect(resolveNonClaudeResumeId(surface(), null, d)).toBe('current')
  })

  it('prefers a hook-log id over recorded history', () => {
    // A botched restart can leave a ghost in history while the log still has
    // the real chat id. This ordering is the fix for that, and it is the whole
    // reason history is consulted late.
    const d = deps({ logs: { [PTY]: [hookLine('Stop', { session_id: 'real' })] } })
    expect(resolveNonClaudeResumeId(surface({ claudeSessionHistory: history('ghost') }), null, d)).toBe('real')
  })

  it('falls back to recorded history when no log has anything', () => {
    expect(resolveNonClaudeResumeId(surface({ claudeSessionHistory: history('a', 'b') }), null, deps())).toBe('b')
  })

  it('falls back to per-terminal-session records last', () => {
    const node = surface({ terminalSessions: [{ claudeSessionId: cid('s1') }, { claudeSessionId: cid('s2') }] })
    expect(resolveNonClaudeResumeId(node, null, deps())).toBe('s2')
  })

  it('skips terminal sessions that never recorded an id', () => {
    const node = surface({ terminalSessions: [{ claudeSessionId: cid('s1') }, {}, {}] })
    expect(resolveNonClaudeResumeId(node, null, deps())).toBe('s1')
  })

  it('returns undefined when nothing anywhere has an id', () => {
    expect(resolveNonClaudeResumeId(surface(), null, deps())).toBeUndefined()
  })

  it('treats an empty live id as no live id', () => {
    expect(resolveNonClaudeResumeId(surface({ claudeSessionHistory: history('h') }), cid(''), deps())).toBe('h')
  })
})

describe('findValidClaudeSession', () => {
  const CWD = '/work/project'

  it('returns the newest session whose transcript exists', () => {
    const d = deps({ transcripts: [`${CWD}::a`, `${CWD}::b`] })
    expect(findValidClaudeSession(history('a', 'b'), CWD, d)).toBe('b')
  })

  it('skips ghost ids and returns the newest real one', () => {
    // A revival can start Claude, get a SessionStart hook registering a new
    // id, then crash before the transcript exists. Picking the newest id
    // blindly makes every subsequent restart pick the same ghost and fail the
    // same way — a cascade that looks like a permanently broken terminal.
    const d = deps({ transcripts: [`${CWD}::real`] })
    expect(findValidClaudeSession(history('real', 'ghost1', 'ghost2'), CWD, d)).toBe('real')
  })

  it('returns undefined when every recorded session is a ghost', () => {
    // A real answer, not a failure: the caller re-archives rather than
    // launching a surface that will die on startup.
    expect(findValidClaudeSession(history('g1', 'g2'), CWD, deps())).toBeUndefined()
  })

  it('returns undefined for an empty history', () => {
    expect(findValidClaudeSession([], CWD, deps())).toBeUndefined()
  })

  it('returns the newest id unverified when there is no cwd', () => {
    // Nothing to check against; refusing to resume would be worse than trying.
    expect(findValidClaudeSession(history('a', 'b'), undefined, deps())).toBe('b')
  })

  it('checks transcripts against the given cwd, not another one', () => {
    const d = deps({ transcripts: ['/elsewhere::a'] })
    expect(findValidClaudeSession(history('a'), CWD, d)).toBeUndefined()
  })
})
