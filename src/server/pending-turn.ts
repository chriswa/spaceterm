import type { PtySessionId } from '../shared/ids'
import { speakableToolText } from './speakable-tool-text'

/**
 * The assistant turn a surface is parked on, which is not yet on disk.
 *
 * Claude Code appends an assistant turn to its transcript JSONL only once that
 * turn's *interactive* tool resolves. `AskUserQuestion` and `ExitPlanMode` are
 * interactive, and `waiting_question`/`waiting_plan` are *defined* by one of
 * them being unresolved — so those two states are exactly the states in which
 * the turn the listener wants summarized has not been written. Measured: a
 * session file frozen for the whole time a question sat on screen, then five
 * entries appended 40ms after it was answered.
 *
 * Non-interactive tools flush immediately, so the gap is always exactly one
 * message: the final one.
 *
 * The hook payload is what closes it. `PreToolUse` carries `tool_input`, which
 * for these two tools *is* the user-facing content, and it arrives before the
 * listener can even press the chord — twelve seconds before, in the case that
 * prompted this. The state machine already reads `tool_name` off that same
 * payload to decide `waiting_question`; this keeps the input it was discarding.
 *
 * What this cannot recover is the prose the agent wrote *above* the tool call,
 * in the same buffered turn. That text exists only inside the running Claude
 * Code process — no hook carries it (`Notification` is just "Claude needs your
 * permission"), and there is no sidecar on disk. Both tools were measured and
 * both lose it. `PENDING_TURN_CAUTION` in `summary-chat.ts` is how the listener
 * is told, because a summary confidently built on the question alone reads as a
 * complete answer.
 */
export type PendingTurn = {
  tool: 'AskUserQuestion' | 'ExitPlanMode'
  /** The tool's input rendered as speakable prose. */
  text: string
  capturedAt: number
}

/** Tools whose input is the message the listener is waiting on. */
const INTERACTIVE_TOOLS = new Set<PendingTurn['tool']>(['AskUserQuestion', 'ExitPlanMode'])

const isInteractiveTool = (name: string): name is PendingTurn['tool'] =>
  INTERACTIVE_TOOLS.has(name as PendingTurn['tool'])

/**
 * The un-flushed turn per surface, if there is one.
 *
 * Deliberately not a general hook-event store. It holds one entry per surface
 * and only for as long as a tool is genuinely pending, so it cannot drift into
 * being a second, staler copy of the transcript: every path that ends a turn
 * clears it, and `prepare` re-checks the transcript before using what is here.
 */
export class PendingTurnCache {
  private pending = new Map<PtySessionId, PendingTurn>()

  /**
   * Record a `PreToolUse` payload, if it is one of the interactive tools.
   *
   * Ignores everything else rather than clearing, because a turn that ends in a
   * question routinely runs other tools on the way there — a Bash call after
   * the question was asked is not possible, but a *stale* entry from an earlier
   * turn is, and that is what `clear` is for.
   */
  record(surfaceId: PtySessionId, toolName: string, toolInput: unknown, now: number): void {
    if (!isInteractiveTool(toolName)) return
    const text = speakableToolText(toolName, toolInput)
    if (!text) return
    this.pending.set(surfaceId, { tool: toolName, text, capturedAt: now })
  }

  /** The turn resolved, a new one began, or the surface went away. */
  clear(surfaceId: PtySessionId): void {
    this.pending.delete(surfaceId)
  }

  get(surfaceId: PtySessionId): PendingTurn | undefined {
    return this.pending.get(surfaceId)
  }
}
