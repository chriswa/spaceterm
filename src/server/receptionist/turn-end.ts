/**
 * Whether a watched agent's message ends its turn for the user, though
 * background work it started keeps it busy.
 *
 * An agent that ends its turn with a subagent, shell or monitor still running
 * sits in "waiting on a background task", which a watch never fires on. An
 * orchestrator lives there: it reports findings, asks questions and finishes
 * what it was sent between its subagents' notifications, and none of it would
 * reach Control. So each turn such an agent ends while watched, Jev is asked
 * whether its final message is a finding, a question or finished work. It is
 * asked strictly, because such agents also end many turns with progress ("now
 * on PR3") that is no news.
 */
import type { JevRequest } from '../agent-search'

/** Jev's probability at or above which the message is told to Control as a stop. Strict: see the module comment. */
export const TURN_END_THRESHOLD = 0.8

export function jevTurnEndRequest(message: string): JevRequest {
  return {
    state: { agent_message: message },
    questions: {
      turn_end: {
        type: 'noul',
        instructions:
          'A coding agent ended its turn with `agent_message`, but work it started in the background (subagents, shell ' +
          'commands, monitors) is still running and will wake it again. A receptionist relays agents\' news to the user by ' +
          'voice. Does this message hand something to the user now: a finding or result they would want to hear, a question ' +
          'or decision only they can make, or a report that what it was asked to do is done? Be strict. Progress reports, ' +
          'plans, acknowledgements, status checks with no change, and notes that it is waiting on or still running ' +
          'something are not, even when long or detailed.',
        criteria: {
          true: 'It delivers a finding or result, asks the user something, or reports the task it was given as finished.',
          false: 'It reports progress, acknowledges an instruction, says nothing changed, or says it is still waiting or working.',
        },
      },
    },
  }
}

/** The probability in a Jev `noul` answer, or undefined if it is not there. */
export function readTurnEndProbability(response: unknown): number | undefined {
  const answer = (response as { answers?: { turn_end?: { noul?: unknown } } } | undefined)?.answers?.turn_end?.noul
  return typeof answer === 'number' && answer >= 0 && answer <= 1 ? answer : undefined
}

/** Jev as the judge, through the `jev` CLI runner the agent search uses. */
export function jevTurnEndJudge(runJev: (request: JevRequest) => Promise<unknown>): (message: string) => Promise<number> {
  return async (message) => {
    const probability = readTurnEndProbability(await runJev(jevTurnEndRequest(message)))
    if (probability === undefined) throw new Error('Jev gave no probability')
    return probability
  }
}
