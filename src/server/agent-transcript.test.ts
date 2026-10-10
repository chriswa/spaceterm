import { describe, it, expect } from 'vitest'
import { finalAgentMessage, parseTranscript, type TranscriptMessage } from './agent-transcript'

describe('parseTranscript', () => {
  const line = (o: unknown): string => JSON.stringify(o)

  it('reads Claude transcript entries', () => {
    const raw = [
      line({ type: 'user', message: { content: 'hello' } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi there' }] } })
    ].join('\n')

    expect(parseTranscript(raw)).toEqual([
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hi there' }
    ])
  })

  it('reads Cursor entries, which put role at the top level', () => {
    const raw = line({ role: 'user', message: { content: 'from cursor' } })
    expect(parseTranscript(raw)).toEqual([{ role: 'user', text: 'from cursor' }])
  })

  it('prefers Codex user_message events over its injected context', () => {
    const raw = [
      line({ type: 'event_msg', payload: { type: 'user_message', message: 'real request' } }),
      line({ type: 'response_item', payload: { type: 'message', role: 'developer', content: 'injected' } }),
      line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] } })
    ].join('\n')

    expect(parseTranscript(raw)).toEqual([
      { role: 'user', text: 'real request' },
      { role: 'assistant', text: 'answer' }
    ])
  })

  it('reads current Codex response-item user turns but skips injected environment context', () => {
    const raw = [
      line({
        type: 'response_item',
        payload: {
          type: 'message', role: 'user',
          content: [{ type: 'input_text', text: '<environment_context>injected setup</environment_context>' }],
          internal_chat_message_metadata_passthrough: { content_item_kinds: ['environments.environment_context'] },
        },
      }),
      line({
        type: 'response_item',
        payload: {
          type: 'message', role: 'user',
          content: [{ type: 'input_text', text: 'review the current changes' }],
          internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] },
        },
      }),
      line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I found an issue.' }] } }),
    ].join('\n')

    expect(parseTranscript(raw)).toEqual([
      { role: 'user', text: 'review the current changes' },
      { role: 'assistant', text: 'I found an issue.' },
    ])
  })

  it('skips ordinary tool calls and thinking blocks', () => {
    const raw = line({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', name: 'Bash' }] }
    })
    expect(parseTranscript(raw)).toEqual([])
  })

  it('includes Cursor CreatePlan bodies — that is the answer while waiting on approval', () => {
    const raw = [
      line({ role: 'user', message: { content: 'fix the stop cue' } }),
      line({
        role: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Drafting the fix plan.' },
            {
              type: 'tool_use',
              name: 'CreatePlan',
              input: {
                name: 'Always play stop cue',
                overview: 'Pair the close cue to a played start cue.',
                plan: '# Root cause\n\nShort silent taps skip the finish cue.\n\n## Verification\n\n- Quick Fn tap hears both cues.',
              },
            },
          ],
        },
      }),
    ].join('\n')

    const parsed = parseTranscript(raw)
    expect(parsed).toHaveLength(2)
    expect(parsed[1].role).toBe('assistant')
    expect(parsed[1].text).toContain('Drafting the fix plan.')
    expect(parsed[1].text).toContain('Plan: Always play stop cue')
    expect(parsed[1].text).toContain('Pair the close cue to a played start cue.')
    expect(parsed[1].text).toContain('Short silent taps skip the finish cue.')
    expect(parsed[1].text).toContain('Quick Fn tap hears both cues.')
  })

  it('includes Claude ExitPlanMode plan bodies the same way', () => {
    const raw = [
      line({ type: 'user', message: { content: 'plan the viewport slots' } }),
      line({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            name: 'ExitPlanMode',
            input: { plan: '# Saved viewport slots\n\nBookmark with Cmd+Shift+N.' },
          }],
        },
      }),
    ].join('\n')

    expect(parseTranscript(raw)).toEqual([{
      role: 'user',
      text: 'plan the viewport slots',
    }, {
      role: 'assistant',
      text: 'Plan\n\n# Saved viewport slots\n\nBookmark with Cmd+Shift+N.',
    }])
  })

  it('ignores a partially written final line', () => {
    const raw = line({ type: 'user', message: { content: 'complete' } }) + '\n{"type":"assis'
    expect(parseTranscript(raw)).toEqual([{ role: 'user', text: 'complete' }])
  })

  it('returns nothing when there is no user message to anchor a turn', () => {
    const raw = line({ type: 'assistant', message: { content: 'orphan' } })
    expect(parseTranscript(raw)).toEqual([])
  })

  it('always retains the latest user message, however long the history', () => {
    const lines = []
    for (let i = 0; i < 200; i++) {
      lines.push(line({ type: 'assistant', message: { content: 'x'.repeat(1000) } }))
    }
    lines.push(line({ type: 'user', message: { content: 'the latest request' } }))

    const parsed = parseTranscript(lines.join('\n'))
    expect(parsed[parsed.length - 1]).toEqual({ role: 'user', text: 'the latest request' })
  })

  // A long unattended run: the human spoke once, hours ago, and the agent has
  // been answering ever since. The message cap used to be spent entirely on
  // that trailing output, leaving no user message to anchor a turn.
  it('retains the latest user message when the turn since it outran the message cap', () => {
    const lines = [line({ type: 'user', message: { content: 'the latest request' } })]
    for (let i = 0; i < 200; i++) {
      lines.push(line({ type: 'assistant', message: { content: `step ${i}` } }))
    }

    const parsed = parseTranscript(lines.join('\n'))
    expect(parsed[0]).toEqual({ role: 'user', text: 'the latest request' })
    expect(parsed.length).toBeLessThanOrEqual(24)
    // The tail of the turn, not its opening: what the agent just did is the answer.
    expect(parsed[parsed.length - 1]).toEqual({ role: 'assistant', text: 'step 199' })
  })

  it('spends the budget on the current turn before older background', () => {
    const lines = []
    for (let i = 0; i < 40; i++) {
      lines.push(line({ type: 'assistant', message: { content: `background ${i}` } }))
    }
    lines.push(line({ type: 'user', message: { content: 'the latest request' } }))
    for (let i = 0; i < 40; i++) {
      lines.push(line({ type: 'assistant', message: { content: `turn ${i}` } }))
    }

    const parsed = parseTranscript(lines.join('\n'))
    expect(parsed[0]).toEqual({ role: 'user', text: 'the latest request' })
    expect(parsed.some(message => message.text.startsWith('background'))).toBe(false)
  })

  it('bounds how much history it keeps', () => {
    const lines = []
    for (let i = 0; i < 200; i++) {
      lines.push(line({ type: 'user', message: { content: `m${i}` } }))
    }
    expect(parseTranscript(lines.join('\n')).length).toBeLessThanOrEqual(24)
  })

  it('preserves chronological order', () => {
    const raw = [
      line({ type: 'user', message: { content: 'first' } }),
      line({ type: 'assistant', message: { content: 'second' } }),
      line({ type: 'user', message: { content: 'third' } })
    ].join('\n')

    expect(parseTranscript(raw).map((m) => m.text)).toEqual(['first', 'second', 'third'])
  })

  it('handles an empty document', () => {
    expect(parseTranscript('')).toEqual([])
  })

  // The shape of an agent that loaded self-terminate: Claude Code files the
  // skill's text as a user turn, marked isMeta. Read as speech, it displaced
  // the real prompt as the turn's anchor.
  it('skips what Claude Code injects as a meta user turn', () => {
    const raw = [
      line({ type: 'user', message: { content: 'find the compaction time, then self-terminate' } }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'self-terminate' } }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'Launching skill: self-terminate' }] } }),
      line({ type: 'user', isMeta: true, message: { content: [{ type: 'text', text: 'Base directory for this skill: …' }] } }),
    ].join('\n')

    expect(parseTranscript(raw)).toEqual([
      { role: 'user', text: 'find the compaction time, then self-terminate' },
      { role: 'assistant', text: '[agent tool activity, not speech] 1 call: Skill.\n- Skill: self-terminate' },
    ])
  })
})

describe('tool activity in a transcript', () => {
  const line = (o: unknown): string => JSON.stringify(o)
  const MARKER = '[agent tool activity, not speech]'

  const toolUse = (name: string, input: unknown): string =>
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } })
  /** Claude writes one entry per content block, with results interleaved between them. */
  const toolResult = (): string =>
    line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'output' }] } })
  const said = (role: string, text: string): string =>
    line({ type: role, message: { content: [{ type: 'text', text }] } })

  const run = (...lines: string[]): TranscriptMessage[] => parseTranscript(lines.join('\n'))
  const activity = (messages: TranscriptMessage[]): TranscriptMessage[] =>
    messages.filter((m) => m.text.startsWith(MARKER))

  it('records what the agent did when it said almost nothing', () => {
    const messages = run(
      said('user', 'find the leak'),
      toolUse('Bash', { command: 'ps aux | grep worker' }), toolResult(),
      toolUse('Read', { file_path: 'src/queue.ts' }), toolResult(),
    )
    expect(activity(messages)).toHaveLength(1)
    expect(activity(messages)[0].text).toContain('ps aux | grep worker')
    expect(activity(messages)[0].text).toContain('src/queue.ts')
  })

  // Emitting one message per call would be worse than nothing: 35 of them would
  // consume the whole budget and push the prose out of the window entirely.
  it('coalesces a run into a single message despite interleaved results', () => {
    const lines = ['{"type":"user","message":{"content":"go"}}']
    for (let i = 0; i < 35; i++) { lines.push(toolUse('Bash', { command: `step ${i}` }), toolResult()) }
    const messages = run(...lines)
    expect(activity(messages)).toHaveLength(1)
    expect(activity(messages)[0].text).toContain('35 calls')
    expect(activity(messages)[0].text).toContain('Bash x35')
  })

  it('names the newest calls and says how many it left out', () => {
    const lines = ['{"type":"user","message":{"content":"go"}}']
    for (let i = 0; i < 35; i++) lines.push(toolUse('Bash', { command: `step ${i}` }))
    const text = activity(run(...lines))[0].text
    expect(text).toContain('step 34')
    expect(text).toContain('step 25')
    expect(text).not.toContain('step 24')
    // Silent truncation would read as a complete account of a much smaller run.
    expect(text).toContain('25 earlier calls not listed')
  })

  it('keeps a short run whole, with nothing to elide', () => {
    const text = activity(run(
      said('user', 'go'),
      toolUse('Bash', { command: 'ls' }),
    ))[0].text
    expect(text).toContain('1 call: Bash.')
    expect(text).not.toContain('not listed')
  })

  it('closes a run at each piece of prose, keeping the trace in step', () => {
    const messages = run(
      said('user', 'go'),
      toolUse('Bash', { command: 'first' }),
      said('assistant', 'Now I will check the other side.'),
      toolUse('Bash', { command: 'second' }),
    )
    expect(messages.map((m) => m.text.startsWith(MARKER)))
      .toEqual([false, true, false, true])
    expect(messages[1].text).toContain('first')
    expect(messages[3].text).toContain('second')
  })

  it('puts an entry\'s prose before the calls it introduces', () => {
    const messages = run(
      said('user', 'go'),
      line({ type: 'assistant', message: { content: [
        { type: 'text', text: 'Let me look.' },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      ] } }),
    )
    expect(messages[1].text).toBe('Let me look.')
    expect(messages[2].text).toContain(MARKER)
  })

  // The name alone describes a night of work and a typo equally well.
  describe('the target it picks', () => {
    const targetOf = (name: string, input: unknown): string =>
      activity(run(said('user', 'go'), toolUse(name, input)))[0].text

    it.each([
      ['Read', { file_path: 'src/a.ts' }, 'src/a.ts'],
      ['Edit', { file_path: 'src/b.ts', old_string: 'x' }, 'src/b.ts'],
      ['Grep', { pattern: 'applySchema', path: 'src' }, 'applySchema'],
      ['Glob', { pattern: '**/*.test.ts' }, '**/*.test.ts'],
      ['Bash', { command: 'npm test', description: 'Run tests' }, 'npm test'],
      ['WebFetch', { url: 'https://example.com/x' }, 'https://example.com/x'],
      ['Task', { description: 'Audit the parser', prompt: 'long prompt' }, 'Audit the parser'],
    ])('reads the identifying field for %s', (name, input, expected) => {
      expect(targetOf(name, input)).toContain(expected)
    })

    it('still records a call whose input it cannot read', () => {
      const text = targetOf('TodoWrite', { todos: [] })
      expect(text).toContain('TodoWrite')
    })

    // A trace that kept the newlines would lose the one-line-per-call shape it
    // is readable because of.
    it('collapses a multi-line command onto one line and bounds it', () => {
      const text = targetOf('Bash', { command: `echo one\n${'x'.repeat(400)}` })
      const traceLines = text.split('\n').filter((l) => l.startsWith('- '))
      expect(traceLines).toHaveLength(1)
      expect(traceLines[0].length).toBeLessThan(140)
      expect(text).toContain('…')
    })
  })

  // These carry the message itself, so they stay speech. Filing a plan as a
  // shell command would bury it.
  it('leaves the interactive tools as messages rather than activity', () => {
    const messages = run(
      said('user', 'go'),
      toolUse('ExitPlanMode', { plan: 'Supervise the workers.' }),
      toolUse('AskUserQuestion', { questions: [{ question: 'Ship it?', header: 'Scope' }] }),
    )
    expect(activity(messages)).toHaveLength(0)
    expect(messages.some((m) => m.text.includes('Supervise the workers.'))).toBe(true)
    expect(messages.some((m) => m.text.includes('Ship it?'))).toBe(true)
  })

  it('ignores a tool call attributed to the user', () => {
    const messages = run(
      said('user', 'go'),
      line({ type: 'user', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'rm -rf /' } }] } }),
    )
    expect(activity(messages)).toHaveLength(0)
  })

  // Thinking is stored as a signature with the text empty, so there is nothing
  // in it to read and nothing to report.
  it('reports nothing for thinking blocks', () => {
    const messages = run(
      said('user', 'go'),
      line({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '', signature: 'abc' }] } }),
    )
    expect(messages).toEqual([{ role: 'user', text: 'go' }])
  })

  it('reads a Codex function call, whose input is a JSON string', () => {
    const messages = run(
      line({ type: 'event_msg', payload: { type: 'user_message', message: 'go' } }),
      line({ type: 'response_item', payload: {
        type: 'function_call', name: 'shell',
        arguments: JSON.stringify({ command: ['bash', '-lc', 'ls -la'], timeout_ms: 120000 }),
      } }),
    )
    expect(activity(messages)[0].text).toContain('shell')
    expect(activity(messages)[0].text).toContain('bash -lc ls -la')
  })

  it('keeps a Codex call whose arguments will not parse', () => {
    const messages = run(
      line({ type: 'event_msg', payload: { type: 'user_message', message: 'go' } }),
      line({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{broken' } }),
    )
    expect(activity(messages)[0].text).toContain('shell')
  })

  // Activity is not speech, so it cannot stand in for the user turn the window
  // anchors on. A transcript of pure tool calls has no turn at all.
  it('does not let activity pass as a user message', () => {
    expect(run(toolUse('Bash', { command: 'ls' }))).toEqual([])
  })
})

/**
 * The agent's final message, the trailing run of what it wrote.
 *
 * Fed the coalesced message list rather than raw JSONL: the tool-activity
 * marker that ends the run is something `parseTranscript` produces, so these
 * fixtures describe what `finalAgentMessage` actually sees.
 */
describe('finalAgentMessage', () => {
  const activityRun = (): TranscriptMessage =>
    ({ role: 'assistant', text: '[agent tool activity, not speech] 2 calls: Bash x2.\n- Bash: ls' })

  it('is the trailing agent prose', () => {
    expect(finalAgentMessage([
      { role: 'user', text: 'do the thing' },
      { role: 'assistant', text: 'Done.' },
    ])).toBe('Done.')
  })

  // Claude Code writes each content block as its own transcript entry, so an
  // uninterrupted message still arrives in pieces. Reading only the last piece
  // would drop the start of the very sentence the listener asked to hear.
  it('rejoins a message that arrived in pieces', () => {
    expect(finalAgentMessage([
      { role: 'user', text: 'do the thing' },
      { role: 'assistant', text: 'First part.' },
      { role: 'assistant', text: 'Second part.' },
    ])).toBe('First part.\n\nSecond part.')
  })

  it('stops at the work the agent did before writing it', () => {
    expect(finalAgentMessage([
      { role: 'user', text: 'do the thing' },
      { role: 'assistant', text: 'Looking into it.' },
      activityRun(),
      { role: 'assistant', text: 'Done.' },
    ])).toBe('Done.')
  })

  it('stops at the user, so it never reads a whole conversation out', () => {
    expect(finalAgentMessage([
      { role: 'assistant', text: 'An earlier answer.' },
      { role: 'user', text: 'and now?' },
      { role: 'assistant', text: 'Done.' },
    ])).toBe('Done.')
  })

  // An agent mid-run has said nothing since its last tool call. That is an
  // ordinary state, not a broken transcript, and the caller says so.
  it('is empty when the turn ended on a tool call', () => {
    expect(finalAgentMessage([
      { role: 'user', text: 'do the thing' },
      activityRun(),
    ])).toBe('')
  })

  it('is empty when the agent has not spoken at all', () => {
    expect(finalAgentMessage([{ role: 'user', text: 'do the thing' }])).toBe('')
  })
})
