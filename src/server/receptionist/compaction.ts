import type { ControlTrace } from '../../shared/protocol'
import { ago } from './roster'

/**
 * A compaction of Control's session, as claude-print-daemon reports it to the
 * first message after it (its `compaction` field: see the daemon's README).
 */
export interface Compaction {
  /**
   * `idle`: the daemon's timer, 55 minutes after the last message, while the
   * prompt cache was still warm. `size`: the context passed `thresholdTokens`.
   */
  trigger: 'idle' | 'size'
  /** When the message before it ended (epoch ms): what an idle compaction counts from. Absent from a daemon too old to say. */
  lastActivity?: number
  /** How long before the reporting message's turn began it finished. */
  finishedBeforeMs: number
  /** How long the reporting message waited for it to finish. */
  waitedMs?: number
  durationMs: number
  tokensBefore: number
  tokensAfter: number
  /** The context size past which the daemon compacts at once. */
  thresholdTokens: number
  costUsd: number
  cachedTokens: number
  uncachedTokens: number
  /** Why it failed; the session then still holds everything. */
  error?: string
}

/**
 * A compaction's line in the transcript, and the detail behind it.
 * `contextWindow` is the model's, when the daemon said; `sentAt` is when the
 * message that heard of it left; `recapped` when that message repeated the
 * last few exchanges to the session.
 */
export function compactionTrace(c: Compaction, contextWindow: number | undefined, sentAt: number, recapped: boolean): Pick<ControlTrace, 'text' | 'detail'> {
  const started = sentAt + (c.waitedMs ?? 0) - c.finishedBeforeMs - c.durationMs
  const idleFor = c.lastActivity !== undefined ? started - c.lastActivity : undefined
  const reason = c.trigger === 'idle'
    ? `idle${idleFor !== undefined ? ` ${ago(idleFor)}` : ''}`
    : 'over the size threshold'
  const share = (tokens: number) => {
    const ofThreshold = `${percent(tokens, c.thresholdTokens)} threshold`
    return contextWindow ? `${percent(tokens, contextWindow)} (${ofThreshold})` : ofThreshold
  }
  const away = c.lastActivity !== undefined ? ` · idle ${ago(sentAt - c.lastActivity)} before this message` : ''
  const text = c.error === undefined
    ? `Memory compacted (${reason}): ${thousands(c.tokensBefore)} → ${thousands(c.tokensAfter)} tokens, ${share(c.tokensBefore)}${away}`
    : `Memory compaction failed (${reason}) at ${thousands(c.tokensBefore)} tokens, ${share(c.tokensBefore)}${away}`

  const window = contextWindow ? ` of ${count(contextWindow)}: ${percent(c.tokensBefore, contextWindow)} → ${percent(c.tokensAfter, contextWindow)}` : ''
  const detail = [
    c.trigger === 'idle'
      ? `Why: idle${idleFor !== undefined ? `, ${ago(idleFor)} after the last message` : ''}, compacted before the prompt cache went cold.`
      : `Why: the context passed the ${count(c.thresholdTokens)}-token threshold, so it was compacted straight after that message.`,
    c.lastActivity !== undefined ? `Last message before this one: ${ago(sentAt - c.lastActivity)} earlier.` : undefined,
    c.error === undefined
      ? `Context: ${count(c.tokensBefore)} → ${count(c.tokensAfter)} tokens${window}; ${percent(c.tokensBefore, c.thresholdTokens)} → ${percent(c.tokensAfter, c.thresholdTokens)} of the ${count(c.thresholdTokens)}-token threshold.`
      : `Context: ${count(c.tokensBefore)} tokens${contextWindow ? ` of ${count(contextWindow)}` : ''}, kept in full.`,
    `Took ${ago(c.durationMs)}, finished ${ago(c.finishedBeforeMs)} before this message${c.waitedMs ? `, which waited ${ago(c.waitedMs)} for it` : ''}.`,
    `Cost $${c.costUsd.toFixed(3)}: ${count(c.cachedTokens)} tokens read from cache, ${count(c.uncachedTokens)} uncached.`,
    c.error !== undefined ? `Error: ${c.error}` : undefined,
    recapped ? 'Its last few messages were repeated to it word for word.' : undefined,
  ].filter(Boolean).join('\n')
  return { text, detail }
}

/** "3%", or "<1%" for a share too small to round to one. */
function percent(part: number, whole: number): string {
  const rounded = Math.round(100 * part / whole)
  return rounded === 0 && part > 0 ? '<1%' : `${rounded}%`
}

/** "20.7k". */
function thousands(tokens: number): string {
  return `${(tokens / 1000).toFixed(1)}k`
}

/** "20,721". */
function count(tokens: number): string {
  return tokens.toLocaleString('en-US')
}
