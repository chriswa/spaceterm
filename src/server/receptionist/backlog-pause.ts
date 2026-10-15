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
 * to something new right now, and could they after `PAUSE_MS` more of quiet?
 * Yes to the first, the next item comes up at once; yes only to the second,
 * after `PAUSE_MS` of quiet; no to both, after `MID_TOPIC_PAUSE_MS` of quiet,
 * since a silence that long ends any topic. Each waits only while nothing
 * breaks the quiet: the user talking, or anything else giving Control a turn.
 *
 * "No to both" used to mean nothing came up until the next reply, however long
 * the silence after it. Jev, shown agents' long reports alongside the user's
 * words, took them for an unfinished topic, and news sat on the backlog through
 * minutes of silence; so Jev is now shown only the dialogue (`pauseDialogue`).
 */
import type { JevRequest } from '../agent-search'
import { splitTurnBody } from './prompt'
import { CONVERSATION_WORDS, lastWords, wordCount } from './self-interruption'

/** Jev's probability at or above which the user counts as ready. Tune from the `backlog-pause` log entries. */
export const READY_THRESHOLD = 0.4
/** The quiet that the second question asks about, and that is waited out before an item it allows comes up. */
export const PAUSE_MS = 4_000
/** The quiet waited out when Jev says the user is still on a topic: by then they have moved on, or put it off. */
export const MID_TOPIC_PAUSE_MS = 30_000
/**
 * How long after the user cuts Control off to talk that nothing new comes up,
 * whatever Jev says: whatever they broke in to say is their topic for a while.
 */
export const INTERRUPTION_QUIET_MS = 20_000

/** Jev's probability for each question: that the user is ready now, and that they will be after `PAUSE_MS` of quiet. */
export interface PauseJudgement {
  now: number
  afterPause: number
}

/**
 * The recent conversation as Jev is shown it, oldest first, one line per
 * message: only what the user and Control said to each other, cut to
 * `CONVERSATION_WORDS`. A turn's events — agents' reports, often long and
 * full of their own open questions — are left out: they are news, not what
 * the user is talking about, and they crowded out the dialogue.
 */
export function pauseDialogue(messages: readonly { role: 'user' | 'assistant'; content: string }[], words = CONVERSATION_WORDS): string {
  const lines = messages.flatMap(({ role, content }) => {
    if (role === 'user') {
      const heard = splitTurnBody(content)?.heard.trim()
      return heard ? [{ who: 'USER', text: heard }] : []
    }
    const text = spokenText(content)
    return text ? [{ who: 'RECEPTIONIST', text }] : []
  })
  const kept: string[] = []
  let left = words
  for (const { who, text } of lines.reverse()) {
    if (left <= 0) break
    const count = wordCount(text)
    kept.unshift(`${who}: ${count <= left ? text : `… ${lastWords(text, left)}`}`)
    left -= count
  }
  return kept.join('\n')
}

/** What a recorded reply of Control's said: its spoken parts, or the action it records ("SENT TO …") as it stands. */
function spokenText(content: string): string {
  if (!content.startsWith('{')) return content.trim()
  try {
    const say = (JSON.parse(content) as { say?: Array<{ text?: unknown }> }).say
    return Array.isArray(say) ? say.map(part => typeof part.text === 'string' ? part.text : '').join(' ').trim() : ''
  } catch {
    return content.trim()
  }
}

export function jevPauseRequest(conversation: string): JevRequest {
  const setting =
    'A voice receptionist helps a user who runs many coding agents, and who can only take one topic at a time. ' +
    'News that came up while they were on a topic was set aside to bring up later. `recent_conversation` is what the user ' +
    '(USER:) and the receptionist (RECEPTIONIST:) said to each other lately, oldest first. The receptionist has just finished ' +
    'speaking, and the user has not answered yet. Most of what this user says is a one-off request — send an agent a message, ' +
    'start a new agent, check on one — which is over once the receptionist confirms it; a run of separate requests like that ' +
    'is not a topic. A topic is real back and forth on one subject that is not finished. '
  return {
    state: { recent_conversation: conversation },
    questions: {
      now: {
        type: 'noul',
        instructions: setting + 'Could the receptionist bring up something new right now, without pulling the user off a topic they are still on?',
        criteria: {
          true: 'Nothing is left open: the receptionist\'s last words ask the user nothing and offer nothing they have yet to accept or decline, ' +
            'and the user is not partway through working something out with the receptionist over several messages.',
          false: 'The receptionist just asked the user something, or offered something they have not answered; or the last few messages ' +
            'go back and forth about one subject that the user has not finished with.',
        },
      },
      after_pause: {
        type: 'noul',
        instructions: setting + `If the user stays silent for ${PAUSE_MS / 1000} more seconds, could the receptionist then bring up something new?`,
        criteria: {
          true: 'A silence that long would mean the user has nothing more to add: nothing is waiting on an answer from them.',
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
  | { when: 'now' | 'after-pause' | 'mid-topic'; reason: 'judged'; probabilities: PauseJudgement }
  | { when: 'not-yet'; reason: 'judge-failed'; error: string }

/** The quiet each judged verdict waits out before its item comes up. */
export const PAUSE_WAIT_MS: Record<'now' | 'after-pause' | 'mid-topic', number> = {
  'now': 0,
  'after-pause': PAUSE_MS,
  'mid-topic': MID_TOPIC_PAUSE_MS,
}

/** When to bring up the next item. A failure to judge brings up nothing: the user can still ask what is next. */
export async function decidePause(conversation: string, judge: (conversation: string) => Promise<PauseJudgement>): Promise<PauseVerdict> {
  let probabilities: PauseJudgement
  try {
    probabilities = await judge(conversation)
  } catch (err) {
    return { when: 'not-yet', reason: 'judge-failed', error: err instanceof Error ? err.message : String(err) }
  }
  const when = probabilities.now >= READY_THRESHOLD ? 'now' : probabilities.afterPause >= READY_THRESHOLD ? 'after-pause' : 'mid-topic'
  return { when, reason: 'judged', probabilities }
}
