/**
 * When Control brings up the next backlog item: at a pause, not when Control
 * remembers to.
 *
 * Left to Control, the backlog was not worked through. It was told to call
 * backlog_next once a topic was wrapped up, and to judge that itself while
 * answering something else; it seldom did, and in silence it could not, since
 * no turn runs to remind it. So the server decides instead. Each time a reply
 * of Control's finishes and the backlog is not empty, Jev is asked two yes/no
 * questions about the conversation so far: could the user comfortably switch
 * to something new right now, and could they if they stay quiet a while
 * longer? Yes to the first, the next item comes up at once; yes only to the
 * second, it comes up after `PAUSE_MS` of quiet, unless the user talks or
 * anything else gives Control a turn first; no to both, it waits for the next
 * reply to finish.
 */
import type { JevRequest } from '../agent-search'

/** Jev's probability at or above which the user counts as ready. Tune from the `backlog-pause` log entries. */
export const READY_THRESHOLD = 0.5
/** The quiet that the second question asks about, and that is waited out before an item it allows comes up. */
export const PAUSE_MS = 15_000

/** Jev's probability for each question: that the user is ready now, and that they will be after `PAUSE_MS` of quiet. */
export interface PauseJudgement {
  now: number
  afterPause: number
}

export function jevPauseRequest(conversation: string): JevRequest {
  const setting =
    'A voice receptionist helps a user who runs many coding agents, and who can only take one topic at a time. ' +
    'Things that came up during a topic were set aside to bring up later. The receptionist has just finished speaking ' +
    '(its words are the YOU: lines in `recent_conversation`), and the user has not answered yet. '
  return {
    state: { recent_conversation: conversation },
    questions: {
      now: {
        type: 'noul',
        instructions: setting + 'Could the receptionist bring up something new right now, without pulling the user off a topic they are still on?',
        criteria: {
          true: 'The topic is finished: nothing the receptionist said is waiting on an answer from the user, and the user has nothing more to do on it.',
          false: 'The receptionist asked the user something, or the user is in the middle of something they will want to say or do next.',
        },
      },
      after_pause: {
        type: 'noul',
        instructions: setting + `If the user stays silent for ${PAUSE_MS / 1000} more seconds, could the receptionist then bring up something new?`,
        criteria: {
          true: 'A silence that long would mean the user has moved on, or is not going to answer.',
          false: 'The user would still be busy with the topic: thinking about a question, reading, or doing something they were asked to.',
        },
      },
    },
  }
}

/** The two probabilities in a Jev answer, or undefined if either is missing. */
export function readPauseJudgement(response: unknown): PauseJudgement | undefined {
  const answers = (response as { answers?: Record<string, { noul?: unknown }> } | undefined)?.answers
  const probability = (key: string): number | undefined => {
    const value = answers?.[key]?.noul
    return typeof value === 'number' && value >= 0 && value <= 1 ? value : undefined
  }
  const now = probability('now')
  const afterPause = probability('after_pause')
  return now === undefined || afterPause === undefined ? undefined : { now, afterPause }
}

/** Jev as the judge, through the `jev` CLI runner the agent search uses. */
export function jevPauseJudge(runJev: (request: JevRequest) => Promise<unknown>): (conversation: string) => Promise<PauseJudgement> {
  return async (conversation) => {
    const judgement = readPauseJudgement(await runJev(jevPauseRequest(conversation)))
    if (!judgement) throw new Error('Jev gave no probabilities')
    return judgement
  }
}

export type PauseVerdict =
  | { when: 'now' | 'after-pause' | 'not-yet'; reason: 'judged'; probabilities: PauseJudgement }
  | { when: 'not-yet'; reason: 'judge-failed'; error: string }

/** When to bring up the next item. A failure to judge brings up nothing: the user can still ask what is next. */
export async function decidePause(conversation: string, judge: (conversation: string) => Promise<PauseJudgement>): Promise<PauseVerdict> {
  let probabilities: PauseJudgement
  try {
    probabilities = await judge(conversation)
  } catch (err) {
    return { when: 'not-yet', reason: 'judge-failed', error: err instanceof Error ? err.message : String(err) }
  }
  const when = probabilities.now >= READY_THRESHOLD ? 'now' : probabilities.afterPause >= READY_THRESHOLD ? 'after-pause' : 'not-yet'
  return { when, reason: 'judged', probabilities }
}
