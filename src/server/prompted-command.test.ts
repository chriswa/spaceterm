import { describe, it, expect } from 'vitest'
import { PromptedCommands, PROMPT_WAIT_MS, type PromptedCommandOutcome } from './prompted-command'
import type { PtySessionId } from '../shared/ids'

const S = 'pty-1' as PtySessionId

function setup() {
  const writes: string[] = []
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []
  const commands = new PromptedCommands({
    write: (_id, data) => writes.push(data),
    later: (fn, ms) => {
      const t = { fn, ms, cancelled: false }
      timers.push(t)
      return () => { t.cancelled = true }
    },
  })
  const outcomes: PromptedCommandOutcome[] = []
  commands.run(S, 'git pull && exit', (o) => outcomes.push(o))
  const fireTimers = () => timers.filter(t => !t.cancelled).forEach(t => t.fn())
  return { commands, writes, outcomes, fireTimers, timers }
}

describe('PromptedCommands', () => {
  it('waits for the first prompt before typing', () => {
    const { commands, writes } = setup()
    expect(writes).toEqual([])
    commands.onPrompt(S)
    expect(writes).toEqual(['git pull && exit\n'])
  })

  it('reports success when the shell exits cleanly', () => {
    const { commands, outcomes } = setup()
    commands.onPrompt(S)
    commands.onExit(S, 0)
    expect(outcomes).toEqual([{ kind: 'exited', exitCode: 0 }])
  })

  it('reports failure when the shell comes back to its prompt', () => {
    const { commands, outcomes } = setup()
    commands.onPrompt(S)
    commands.onPrompt(S)
    expect(outcomes).toEqual([{ kind: 'returned-to-prompt' }])
  })

  it('reports once, and forgets the session afterwards', () => {
    const { commands, outcomes } = setup()
    commands.onPrompt(S)
    commands.onPrompt(S)
    commands.onPrompt(S)
    commands.onExit(S, 0)
    expect(outcomes).toHaveLength(1)
  })

  it('types anyway if no prompt is reported in time', () => {
    const { writes, fireTimers, timers } = setup()
    expect(timers[0].ms).toBe(PROMPT_WAIT_MS)
    fireTimers()
    expect(writes).toEqual(['git pull && exit\n'])
  })

  it('treats a late first prompt as the shell arriving, not the command failing', () => {
    const { commands, writes, outcomes, fireTimers } = setup()
    fireTimers()
    commands.onPrompt(S)
    expect(outcomes).toEqual([])
    expect(writes).toHaveLength(1)
    commands.onPrompt(S)
    expect(outcomes).toEqual([{ kind: 'returned-to-prompt' }])
  })

  it('cancels the fallback once the prompt arrives', () => {
    const { commands, timers } = setup()
    commands.onPrompt(S)
    expect(timers[0].cancelled).toBe(true)
  })

  it('reports an exit before the command was typed', () => {
    const { commands, outcomes, writes } = setup()
    commands.onExit(S, 1)
    expect(outcomes).toEqual([{ kind: 'exited', exitCode: 1 }])
    expect(writes).toEqual([])
  })

  it('ignores sessions it is not running anything in', () => {
    const { commands, writes, outcomes } = setup()
    commands.onPrompt('other' as PtySessionId)
    commands.onExit('other' as PtySessionId, 0)
    expect(writes).toEqual([])
    expect(outcomes).toEqual([])
  })

  it('types input with no outcome wanted, then lets the session go', () => {
    const writes: string[] = []
    const commands = new PromptedCommands({ write: (_id, data) => writes.push(data), later: () => () => {} })
    commands.run(S, 'echo hi')
    commands.onPrompt(S)
    commands.onPrompt(S)
    commands.onExit(S, 0)
    expect(writes).toEqual(['echo hi\n'])
  })
})
