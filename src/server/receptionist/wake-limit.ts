import * as fs from 'fs'
import * as path from 'path'
import { SOCKET_DIR } from '../../shared/protocol'

/**
 * How big an agent's context may be for Control to wake it from a cold cache
 * without checking with the user first.
 *
 * Waking a cold agent makes it write its whole conversation to the cache
 * again, and what that costs depends on how much Claude usage the machine has
 * to spend, so the limit is set per machine: from SpacetermBar's menu
 * (`menubar/Sources/SpacetermBar/Settings.swift`), into a file in the
 * machine's own `~/.spaceterm`. It is advice, not a gate: the cache line
 * Control sees in list_agents, agent_details and read says which side of the
 * limit an agent is on, and its instructions say to ask above it. Nothing
 * refuses an ask_agent.
 *
 * Read each time a cache line is written, so a change in the menu applies at
 * once, without a restart. Not part of Control's system prompt, which must not
 * change with it: a new prompt is a new session.
 */

/** Where SpacetermBar writes the setting. Other keys in it are kept as they are. */
export const CONTROL_SETTINGS_FILE = path.join(SOCKET_DIR, 'control.json')
/**
 * The setting's key in that file: tokens of context, at or under which a cold
 * agent may be woken without asking, or `null` for no limit, when any may be.
 */
export const WAKE_LIMIT_KEY = 'wakeWithoutAskingTokens'
/** No limit: Control may wake any cold agent without asking, whatever its size. Stored as `null`. */
export const NO_WAKE_LIMIT = Number.POSITIVE_INFINITY
/** What the menu offers. Any other non-negative number in the file is honoured too. */
export const WAKE_LIMIT_CHOICES = [0, 100_000, 250_000, 500_000, NO_WAKE_LIMIT] as const
/**
 * With no setting: no limit, so a machine that has not chosen one, or a model
 * with a bigger context than any choice, needs nothing changed. SpacetermBar
 * shows the same default.
 */
export const DEFAULT_WAKE_LIMIT = NO_WAKE_LIMIT
/**
 * A cache with less than this left counts as cold already: a side question
 * asked now may reach it after it has gone, and then pays for the whole
 * conversation without the wake-up that would have made it pay only once.
 */
export const NEARLY_COLD_MS = 2 * 60_000

/** The limit in the settings file's text: `NO_WAKE_LIMIT` for `null`, and the default when it is missing, unreadable or neither `null` nor a non-negative number. */
export function parseWakeLimit(text: string | undefined): number {
  if (text === undefined) return DEFAULT_WAKE_LIMIT
  try {
    const value: unknown = (JSON.parse(text) as Record<string, unknown> | null)?.[WAKE_LIMIT_KEY]
    if (value === null) return NO_WAKE_LIMIT
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : DEFAULT_WAKE_LIMIT
  } catch {
    return DEFAULT_WAKE_LIMIT
  }
}

/** This machine's limit, read now. */
export function readWakeLimit(file: string = CONTROL_SETTINGS_FILE): number {
  let text: string | undefined
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    text = undefined
  }
  return parseWakeLimit(text)
}

/** A token count as the cache line says it: "250k tokens", "1 million tokens". */
export function tokenWords(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = Math.round(tokens / 100_000) / 10
    return `${millions} million tokens`
  }
  return `${Math.round(tokens / 1000)}k tokens`
}

/**
 * What the cache line adds about the limit, or nothing while the cache is
 * comfortably warm: a question then reads the cache, whatever its size.
 */
export function wakeWords(agent: { cacheWarmUntil?: number; cacheWarmTokens?: number }, now: number, limit: number): string | undefined {
  if (agent.cacheWarmUntil === undefined || agent.cacheWarmUntil - now >= NEARLY_COLD_MS) return undefined
  const soon = agent.cacheWarmUntil > now ? 'about to go cold, so treat it as cold: ' : ''
  const ask = 'check with the user before asking it'
  const free = 'you may ask it without checking with the user'
  if (limit <= 0) return `${soon}this machine wakes no cold agent without asking, so ${ask}`
  if (limit === NO_WAKE_LIMIT) return `${soon}this machine wakes any cold agent without asking, whatever its size, so ${free}`
  const setting = `the ${tokenWords(limit)} this machine wakes without asking`
  const tokens = agent.cacheWarmTokens
  if (tokens === undefined) return `${soon}its size is unknown, so ${ask}`
  return tokens > limit ? `${soon}above ${setting}, so ${ask}` : `${soon}within ${setting}, so ${free}`
}
