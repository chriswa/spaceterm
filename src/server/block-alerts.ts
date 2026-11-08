/**
 * Tells the phones when an agent stops on a prompt only the user can answer,
 * and when that prompt is over.
 *
 * Unlike Control's news of a block (`Receptionist.agentBlocked`), this does
 * not wait to see whether the block holds: a notification that arrives late is
 * the failure it exists to prevent, and one for a prompt answered a moment
 * later is withdrawn by `block-alert-cleared`.
 */

import type { NodeId } from '../shared/ids'
import type { BlockAlertClearedMessage, BlockAlertMessage } from '../shared/protocol'
import type { ClaudeState } from '../shared/state'
import { describeBlock, isBlocked, type BlockingPrompt, type BlockedState } from './receptionist/blocked'

export interface BlockAlertsDeps {
  send(message: BlockAlertMessage | BlockAlertClearedMessage): void
  /** What the user calls this agent. */
  title(nodeId: NodeId): string
}

export class BlockAlerts {
  /** The block each agent was last alerted for, by which a repeat is known. */
  private readonly alerted = new Map<NodeId, { state: BlockedState; prompt: BlockingPrompt | undefined }>()

  constructor(private readonly deps: BlockAlertsDeps) {}

  /**
   * Every state the state machine sets, including the ones it merely
   * re-asserts. A new PermissionRequest is a new `prompt` object, so asking
   * again in the same state alerts again, while a re-assertion does not. With
   * no record of an alert — a server restart forgets them and the prompts —
   * an unchanged state is a block already told of before the restart.
   */
  observe(nodeId: NodeId, previous: ClaudeState, state: ClaudeState, prompt: BlockingPrompt | undefined): void {
    if (!isBlocked(state)) {
      if (this.alerted.delete(nodeId)) this.deps.send({ type: 'block-alert-cleared', nodeId })
      return
    }
    const last = this.alerted.get(nodeId)
    const repeat = last ? last.state === state && last.prompt === prompt : previous === state && prompt === undefined
    if (repeat) return
    this.alerted.set(nodeId, { state, prompt })
    const said = describeBlock(state, prompt)
    this.deps.send({ type: 'block-alert', nodeId, title: this.deps.title(nodeId), body: said[0].toUpperCase() + said.slice(1) })
  }
}
