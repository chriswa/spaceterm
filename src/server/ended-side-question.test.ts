import { describe, it, expect } from 'vitest'
import { askEndedSession, lastRequestSettings, NO_TOOLS_SETTINGS, readPrintResult, type EndedAskDeps } from './ended-side-question'

const NOW = Date.parse('2026-10-10T23:45:00Z')
const HOUR = 60 * 60_000

/** `claude -p --output-format json` as an ended session's resume printed it, cut to the fields read. */
const printed = (fields: Record<string, unknown>): string => JSON.stringify({
  type: 'result',
  usage: {
    input_tokens: 2, output_tokens: 102, cache_read_input_tokens: 51_632, cache_creation_input_tokens: 1_499,
    cache_creation: { ephemeral_1h_input_tokens: 1_499, ephemeral_5m_input_tokens: 0 },
  },
  ...fields,
})

describe('readPrintResult', () => {
  it('reads an answer, with what it took from the cache and how long that keeps it warm', () => {
    const read = readPrintResult(printed({ subtype: 'success', result: ' It compacted at 3:41. ' }), '', 1_800, NOW)
    expect(read.result).toEqual({
      ok: true, text: 'It compacted at 3:41.', ms: 1_800,
      usage: { input_tokens: 2, output_tokens: 102, cache_read_input_tokens: 51_632, cache_creation_input_tokens: 1_499 },
    })
    expect(read.cacheWarmUntil).toBe(NOW + HOUR)
  })

  it('is an empty reply when the copy reached for a tool and the turn ran out', () => {
    const read = readPrintResult(printed({ subtype: 'error_max_turns', result: null }), '', 0, NOW)
    expect(read.result).toEqual({ ok: false, reason: 'empty-reply' })
    // It still read the cache, which keeps it warm.
    expect(read.usage?.cache_read_input_tokens).toBe(51_632)
  })

  it('is a failed resume when claude printed something other than JSON', () => {
    const read = readPrintResult('', 'No conversation found with session ID: abc\n', 0, NOW)
    expect(read.result).toEqual({ ok: false, reason: 'resume-failed', detail: 'No conversation found with session ID: abc' })
  })

  it('does not move the deadline when the request stated no lifetime', () => {
    const read = readPrintResult(JSON.stringify({ subtype: 'success', result: 'ok', usage: { cache_read_input_tokens: 10 } }), '', 0, NOW)
    expect(read.cacheWarmUntil).toBeUndefined()
  })
})

describe('lastRequestSettings', () => {
  const entry = (o: unknown) => JSON.stringify(o)

  it('takes the model and effort of the last real request', () => {
    const tail = [
      '{"cut off the start of a line',
      entry({ type: 'assistant', effort: 'high', message: { model: 'claude-opus-5-5' } }),
      entry({ type: 'user', message: { content: 'x' } }),
      entry({ type: 'assistant', effort: 'medium', message: { model: 'claude-opus-5-5' } }),
      entry({ type: 'assistant', message: { model: '<synthetic>' } }),
      entry({ type: 'cost-state' }),
    ].join('\n')
    expect(lastRequestSettings(tail)).toEqual({ model: 'claude-opus-5-5', effort: 'medium' })
  })

  it('is nothing for a transcript with no request', () => {
    expect(lastRequestSettings('')).toEqual({})
  })
})

describe('askEndedSession', () => {
  const fake = (out: { stdout?: string; stderr?: string; timedOut?: boolean } | Error) => {
    const runs: Array<{ args: readonly string[]; stdin: string; cwd: string }> = []
    const deps: EndedAskDeps = {
      runClaude: async (args, stdin, cwd) => {
        runs.push({ args, stdin, cwd })
        if (out instanceof Error) throw out
        return { stdout: out.stdout ?? '', stderr: out.stderr ?? '', timedOut: out.timedOut ?? false }
      },
      transcriptTail: () => JSON.stringify({ type: 'assistant', effort: 'medium', message: { model: 'claude-opus-5-5' } }),
    }
    return { deps, runs }
  }

  it('resumes a throwaway fork of the session, as it last ran, with tools refused', async () => {
    const { deps, runs } = fake({ stdout: printed({ subtype: 'success', result: 'At 3:41.' }) })
    const answer = await askEndedSession({ claudeSessionId: 'emma', cwd: '/Users/me/spaceterm', transcriptPath: '/t/emma.jsonl' }, 'When?', deps, () => NOW)
    expect(answer.result.ok).toBe(true)
    expect(answer.cacheWarmUntil).toBe(NOW + HOUR)
    expect(runs).toHaveLength(1)
    const { args, stdin, cwd } = runs[0]
    expect(cwd).toBe('/Users/me/spaceterm')
    expect(stdin).toBe('When?')
    expect(args).toEqual(expect.arrayContaining(['-p', '--fork-session', '--no-session-persistence']))
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2)).toEqual(['--resume', 'emma'])
    expect(args.slice(args.indexOf('--max-turns'), args.indexOf('--max-turns') + 2)).toEqual(['--max-turns', '1'])
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'claude-opus-5-5'])
    expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2)).toEqual(['--effort', 'medium'])
    expect(args.slice(args.indexOf('--settings'), args.indexOf('--settings') + 2)).toEqual(['--settings', NO_TOOLS_SETTINGS])
    // Anything that changes the tool list changes the start of the request, and misses the cache.
    expect(args).not.toContain('--tools')
    expect(args).not.toContain('--disallowedTools')
  })

  it('is a timeout when claude took too long', async () => {
    const { deps } = fake({ timedOut: true })
    expect((await askEndedSession({ claudeSessionId: 'emma', cwd: '/x' }, 'When?', deps, () => NOW)).result).toEqual({ ok: false, reason: 'timeout' })
  })

  it('is a failed resume when claude could not be started', async () => {
    const { deps } = fake(new Error('could not run claude: spawn claude ENOENT'))
    expect((await askEndedSession({ claudeSessionId: 'emma', cwd: '/x' }, 'When?', deps, () => NOW)).result)
      .toEqual({ ok: false, reason: 'resume-failed', detail: 'could not run claude: spawn claude ENOENT' })
  })
})
