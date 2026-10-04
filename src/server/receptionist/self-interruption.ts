/**
 * Self-interruption: news that arrives while Control is speaking may cut its
 * own reply short.
 *
 * Today an event waits for Control to finish talking. That is right when the
 * rest of the reply still stands, and wrong when the news makes it out of date
 * — Control carrying on about Kevin still working after Kevin has finished —
 * or when the news cannot wait. So when an event arrives mid-speech, Jev is
 * asked one yes/no question with the reply so far, the word being spoken, what
 * is still to come, the recent conversation and the news, and answers with the
 * probability that Control should stop now. At or above the threshold Control
 * stops, says "Hang on.", and takes the news; below it, it finishes and takes
 * the news after, as before.
 *
 * Not asked at all when little is left to say: a dozen words is a few seconds,
 * and finishing them costs less than a model call and a cut.
 */
import type { JevRequest } from '../agent-search'

/** Jev's probability at or above which Control cuts itself off. Tuned from the `self-interruption` log entries. */
export const INTERRUPT_THRESHOLD = 0.5
/** At or below this many words still to say, Control finishes without asking. */
export const MIN_WORDS_LEFT = 12
/** How much of the recent conversation Jev is shown, in words. */
export const CONVERSATION_WORDS = 500
/** What Control says as it cuts itself off, before taking the news. */
export const HANG_ON = 'Hang on.'

/** A reply split where the voice is: heard, being said, still to come. */
export interface SpeechSoFar {
  said: string
  /** The word under the voice now, or '' between words or before the first. */
  currentWord: string
  remaining: string
}

/**
 * Split spoken text at a character offset that falls just past the word the
 * listener is hearing (the convention both Voice Operator and the phone report
 * by): that word is `currentWord`, everything before it `said`.
 */
export function splitAtOffset(text: string, offset: number): SpeechSoFar {
  const at = Math.max(0, Math.min(offset, text.length))
  const before = text.slice(0, at)
  const word = /[\w'’-]+$/.exec(before)
  const currentWord = word ? word[0] : ''
  return {
    said: before.slice(0, before.length - currentWord.length).trimEnd(),
    currentWord,
    remaining: text.slice(at).trim(),
  }
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

/** The last `words` words of a text, whole words only. */
export function lastWords(text: string, words: number): string {
  const all = text.split(/\s+/).filter(Boolean)
  return all.slice(-words).join(' ')
}

/** Everything Jev is shown. */
export interface InterruptionContext {
  speech: SpeechSoFar
  /** The recent conversation, oldest first, already cut to CONVERSATION_WORDS. */
  conversation: string
  /** The news, one line each, as the model would be told it. */
  events: string[]
}

export function jevInterruptionRequest(ctx: InterruptionContext): JevRequest {
  return {
    state: {
      recent_conversation: ctx.conversation,
      reply_already_said: ctx.speech.said,
      word_being_said_now: ctx.speech.currentWord,
      reply_still_to_say: ctx.speech.remaining,
      news_just_arrived: ctx.events.join('\n'),
    },
    questions: {
      interrupt: {
        type: 'noul',
        instructions:
          'A voice receptionist is reading a reply aloud to a user (`reply_already_said`, then `word_being_said_now`, then ' +
          '`reply_still_to_say`) when news about one of the user\'s coding agents arrives (`news_just_arrived`). ' +
          'Should it stop mid-reply to bring the news now? Yes if the news makes a substantial part of `reply_still_to_say` ' +
          'out of date or wrong, or if the news is critical enough that the user should hear it right away. ' +
          'No if the rest of the reply still stands and the news can wait until it ends.',
        criteria: {
          true: 'Much of what is still to be said is now stale or contradicted, or the news is urgent.',
          false: 'What is still to be said still stands, and the news can wait for the reply to finish.',
        },
      },
    },
  }
}

/** The probability in a Jev `noul` answer, or undefined if it is not there. */
export function readInterruptProbability(response: unknown): number | undefined {
  const answer = (response as { answers?: { interrupt?: { noul?: unknown } } } | undefined)?.answers?.interrupt?.noul
  return typeof answer === 'number' && answer >= 0 && answer <= 1 ? answer : undefined
}

export type InterruptionVerdict =
  | { interrupt: false; reason: 'few-words'; wordsLeft: number }
  | { interrupt: false; reason: 'judge-failed'; wordsLeft: number; error: string }
  | { interrupt: boolean; reason: 'judged'; wordsLeft: number; probability: number }

/**
 * Whether Control should cut itself off for the news. `judge` is Jev's
 * probability; a failure to judge keeps talking, as Control did before this
 * existed.
 */
export async function decideInterruption(
  ctx: InterruptionContext, judge: (ctx: InterruptionContext) => Promise<number>,
): Promise<InterruptionVerdict> {
  const wordsLeft = wordCount(ctx.speech.remaining)
  if (wordsLeft <= MIN_WORDS_LEFT) return { interrupt: false, reason: 'few-words', wordsLeft }
  let probability: number
  try {
    probability = await judge(ctx)
  } catch (err) {
    return { interrupt: false, reason: 'judge-failed', wordsLeft, error: err instanceof Error ? err.message : String(err) }
  }
  return { interrupt: probability >= INTERRUPT_THRESHOLD, reason: 'judged', wordsLeft, probability }
}

/** Jev as the judge, through the `jev` CLI runner the agent search uses. */
export function jevJudge(runJev: (request: JevRequest) => Promise<unknown>): (ctx: InterruptionContext) => Promise<number> {
  return async (ctx) => {
    const probability = readInterruptProbability(await runJev(jevInterruptionRequest(ctx)))
    if (probability === undefined) throw new Error('Jev gave no probability')
    return probability
  }
}
