import type { PtySessionId } from '../shared/ids'

/**
 * How a command typed into a shell with `&& exit` after it ended.
 *
 * - `exited` — the shell went away; `exitCode` 0 means the command succeeded
 *   and `exit` ran.
 * - `returned-to-prompt` — the shell drew another prompt, which with `&& exit`
 *   means the command failed. The terminal stays open with its output.
 */
export type PromptedCommandOutcome =
  | { kind: 'exited'; exitCode: number }
  | { kind: 'returned-to-prompt' }

export interface PromptedCommandDeps {
  write(sessionId: PtySessionId, data: string): void
  /** Schedule `fn`; returns a cancel function. */
  later(fn: () => void, ms: number): () => void
}

const REAL_DEPS: PromptedCommandDeps = {
  write: () => { throw new Error('PromptedCommands needs a write dep') },
  later: (fn, ms) => {
    const t = setTimeout(fn, ms)
    return () => clearTimeout(t)
  },
}

/**
 * If a shell has not reported its first prompt by now, type the command anyway.
 * Either its rc files are slow — the first prompt is still coming, and is not
 * the command failing — or it has no OSC 7 hook (e.g. fish), in which case
 * failure is undetectable and the command reads as running until its terminal
 * is closed.
 */
export const PROMPT_WAIT_MS = 5000

interface Pending {
  /** Absent when the caller only wants the input typed, not the outcome. */
  /**
   * `typed-early`: typed by the fallback before any prompt, so the next prompt
   * is the shell's first, not the command's return.
   */
  phase: 'awaiting-prompt' | 'typed-early' | 'running'
  input: string
  onDone?: (outcome: PromptedCommandOutcome) => void
  cancelFallback: () => void
}

/**
 * Types input into a fresh shell once it is ready, and — if asked — reports
 * whether the shell then exited or came back to its prompt.
 *
 * "A prompt was drawn" is the OSC 7 cwd report our shell integration emits from
 * `precmd` — the server calls `onPrompt` for every one. Waiting for the first
 * means the command is not typed into a shell still reading its rc files.
 */
export class PromptedCommands {
  private readonly pending = new Map<PtySessionId, Pending>()
  private readonly deps: PromptedCommandDeps

  constructor(deps: Partial<PromptedCommandDeps> & Pick<PromptedCommandDeps, 'write'>) {
    this.deps = { ...REAL_DEPS, ...deps }
  }

  run(sessionId: PtySessionId, input: string, onDone?: (outcome: PromptedCommandOutcome) => void): void {
    const cancelFallback = this.deps.later(() => this.type(sessionId, 'typed-early'), PROMPT_WAIT_MS)
    this.pending.set(sessionId, { phase: 'awaiting-prompt', input, onDone, cancelFallback })
  }

  onPrompt(sessionId: PtySessionId): void {
    const p = this.pending.get(sessionId)
    if (!p) return
    if (p.phase === 'awaiting-prompt') {
      this.type(sessionId, 'running')
      return
    }
    if (p.phase === 'typed-early') {
      p.phase = 'running'
      return
    }
    this.finish(sessionId, { kind: 'returned-to-prompt' })
  }

  onExit(sessionId: PtySessionId, exitCode: number): void {
    this.finish(sessionId, { kind: 'exited', exitCode })
  }

  private type(sessionId: PtySessionId, next: 'typed-early' | 'running'): void {
    const p = this.pending.get(sessionId)
    if (!p || p.phase !== 'awaiting-prompt') return
    p.cancelFallback()
    p.phase = next
    this.deps.write(sessionId, p.input + '\n')
    if (!p.onDone) this.pending.delete(sessionId)
  }

  private finish(sessionId: PtySessionId, outcome: PromptedCommandOutcome): void {
    const p = this.pending.get(sessionId)
    if (!p) return
    p.cancelFallback()
    this.pending.delete(sessionId)
    p.onDone?.(outcome)
  }
}
