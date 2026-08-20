import { describe, it, expect } from 'vitest'
import { speakableToolText } from './speakable-tool-text'
import payloads from './testing/interactive-tool-payloads.json'

/**
 * The fixtures keep the exact *shape* of real `PreToolUse` payloads captured
 * from `~/.spaceterm/hook-logs` — nesting, field names, the "(Recommended)"
 * suffix convention, a plan body that opens with a markdown heading — with the
 * wording replaced. Hook events are data, not collaborators, so what has
 * regression value is the structure Claude Code actually emits rather than any
 * particular conversation's text.
 */
describe('speakableToolText', () => {
  describe('AskUserQuestion', () => {
    const rendered = speakableToolText('AskUserQuestion', payloads.askUserQuestion)!

    it('renders every question', () => {
      expect(rendered).toContain('Retries are enabled in production')
      expect(rendered).toContain('Should those restarts be recorded')
    })

    it('renders each question header', () => {
      expect(rendered).toContain('(Scope)')
      expect(rendered).toContain('(Visibility)')
    })

    // The listener's next move is to pick one. A summary naming only the topic
    // sends them back to the screen, which is the trip Summary Chat exists to
    // save them.
    it('renders the options with their descriptions', () => {
      expect(rendered).toContain('Include it (Recommended)')
      expect(rendered).toContain('Recovery only')
      expect(rendered).toContain('Record and show in History (Recommended)')
      expect(rendered).toContain('Journal only')
      expect(rendered).toContain('a constant in the queue module')
    })

    it('says who is asking, so a summary does not attribute it to the listener', () => {
      expect(rendered.startsWith('The agent is asking the user to decide:')).toBe(true)
    })
  })

  describe('ExitPlanMode', () => {
    it('renders the plan body', () => {
      const rendered = speakableToolText('ExitPlanMode', payloads.exitPlanMode)!
      expect(rendered).toContain('Dashboard: offline mode and blocklists')
      expect(rendered.startsWith('Plan')).toBe(true)
    })

    it("names a Cursor plan, which carries a name and overview Claude's does not", () => {
      const rendered = speakableToolText('CreatePlan', {
        name: 'Rework the switcher',
        overview: 'Two commits, no player drop.',
        plan: '1. Add the guard.',
      })!
      expect(rendered).toContain('Plan: Rework the switcher')
      expect(rendered).toContain('Two commits, no player drop.')
      expect(rendered).toContain('1. Add the guard.')
    })
  })

  // Machinery, not a message. A spoken summary that recited Bash invocations
  // would bury the one sentence the listener pressed the chord for.
  it('renders nothing for tools whose input is not the message', () => {
    expect(speakableToolText('Bash', { command: 'ls' })).toBeUndefined()
    expect(speakableToolText('Grep', { pattern: 'x' })).toBeUndefined()
  })

  /**
   * These payloads cross a socket from another process and may move on without
   * this code. Rendering nothing is the required failure — a throw here lands
   * inside a chord press and takes the whole summary with it.
   */
  describe('malformed input', () => {
    it.each([
      ['a missing input', 'AskUserQuestion', undefined],
      ['a null input', 'AskUserQuestion', null],
      ['a non-object input', 'AskUserQuestion', 'questions'],
      ['no questions array', 'AskUserQuestion', {}],
      ['an empty questions array', 'AskUserQuestion', { questions: [] }],
      ['questions that are not objects', 'AskUserQuestion', { questions: [null, 7] }],
      ['a question with no text', 'AskUserQuestion', { questions: [{ header: 'Scope' }] }],
      ['a plan that is not a string', 'ExitPlanMode', { plan: 42 }],
      ['a blank plan', 'ExitPlanMode', { plan: '   ' }],
      ['a non-string tool name', undefined, { plan: 'x' }],
    ])('returns undefined for %s', (_label, name, input) => {
      expect(speakableToolText(name, input)).toBeUndefined()
    })

    it('keeps the questions it can read when one is unreadable', () => {
      const rendered = speakableToolText('AskUserQuestion', {
        questions: [{ question: 'Ship it?' }, null, { header: 'orphan' }],
      })
      expect(rendered).toContain('Ship it?')
    })

    it('renders a question whose options are malformed', () => {
      const rendered = speakableToolText('AskUserQuestion', {
        questions: [{ question: 'Ship it?', options: 'yes or no' }],
      })
      expect(rendered).toContain('Ship it?')
    })
  })
})
