import { randomUUID } from 'crypto'
import type { LocationFix } from '../shared/location'

/**
 * Finds the user's position for an agent, by asking the client devices.
 *
 * The server has no position of its own, and which device is "the one the
 * user is using" is a guess: so every client that can answer is asked at
 * once, and the answer kept is the one from the best-ranked device that has
 * a fix. A better-ranked device still thinking holds the answer back, until
 * it answers, disconnects or the deadline comes; a failed one passes to the
 * next. That way the phone in the user's hand wins over the Mac on the desk,
 * but a phone that is asleep or has no permission costs only its own
 * failure, not the whole request.
 *
 * Nothing is kept once a request settles.
 */

/** One client able to answer, as `candidates()` ranks them. */
export interface LocationCandidate {
  clientId: string
  /** What the user calls the device ("iPhone", "Mac"), for the agent and the log. */
  device: string
}

export type LocationAnswer = { ok: true; fix: LocationFix } | { ok: false; error: string }

export interface Located {
  device: string
  fix: LocationFix
}

export interface LocationBrokerDeps {
  /** The clients that can answer, the one the user is most likely holding first. */
  candidates(): LocationCandidate[]
  /** Send `location-request` to one client. */
  ask(clientId: string, requestId: string): void
  /** Run `fn` after `ms`; returns a cancel. Defaults to `setTimeout`. */
  schedule?(ms: number, fn: () => void): () => void
}

/** Longer than a client's own limit (CLIENT_LOCATION_TIMEOUT_MS), so it is heard saying why. */
export const LOCATION_DEADLINE_MS = 20_000

const REAL_SCHEDULE = (ms: number, fn: () => void): (() => void) => {
  const timer = setTimeout(fn, ms)
  return () => clearTimeout(timer)
}

/**
 * One request's answers so far, and whether they decide it. Pure: the
 * broker feeds it answers and the deadline, and acts on what it says.
 */
export class LocationTally {
  private readonly answers = new Map<string, LocationAnswer>()

  constructor(private readonly ranked: readonly LocationCandidate[]) {}

  /** Record one client's answer; an unknown or repeated one is ignored. */
  record(clientId: string, answer: LocationAnswer): void {
    if (!this.ranked.some((c) => c.clientId === clientId) || this.answers.has(clientId)) return
    this.answers.set(clientId, answer)
  }

  /**
   * The decision, once there is one: the first-ranked fix with no
   * better-ranked device still to answer, or failure once all have failed.
   * Undefined while it waits.
   */
  outcome(): Located | Error | undefined {
    for (const candidate of this.ranked) {
      const answer = this.answers.get(candidate.clientId)
      if (!answer) return undefined
      if (answer.ok) return { device: candidate.device, fix: answer.fix }
    }
    return this.failure()
  }

  /** At the deadline: the best fix in, whoever is still thinking, or failure. */
  expire(): Located | Error {
    for (const candidate of this.ranked) {
      const answer = this.answers.get(candidate.clientId)
      if (answer?.ok) return { device: candidate.device, fix: answer.fix }
    }
    return this.failure()
  }

  private failure(): Error {
    if (this.ranked.length === 0) {
      return new Error('No Spaceterm client is connected to read a location from. Open Spaceterm on the phone or the Mac.')
    }
    const reasons = this.ranked.map((c) => {
      const answer = this.answers.get(c.clientId)
      return `${c.device}: ${answer && !answer.ok ? answer.error : 'no answer in time'}`
    })
    return new Error(`No device could give a location (${reasons.join('; ')}).`)
  }
}

interface Pending {
  tally: LocationTally
  settle(result: Located | Error): void
}

export class LocationBroker {
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly deps: LocationBrokerDeps) {}

  /** Ask every candidate; resolves with the chosen fix, rejects with each device's reason. */
  locate(deadlineMs = LOCATION_DEADLINE_MS): Promise<Located> {
    const ranked = this.deps.candidates()
    const tally = new LocationTally(ranked)
    const early = tally.outcome()
    if (early) return early instanceof Error ? Promise.reject(early) : Promise.resolve(early)

    const requestId = randomUUID()
    return new Promise<Located>((resolve, reject) => {
      let cancel = (): void => {}
      const settle = (result: Located | Error): void => {
        if (!this.pending.delete(requestId)) return
        cancel()
        if (result instanceof Error) reject(result)
        else resolve(result)
      }
      this.pending.set(requestId, { tally, settle })
      cancel = (this.deps.schedule ?? REAL_SCHEDULE)(deadlineMs, () => settle(tally.expire()))
      for (const candidate of ranked) this.deps.ask(candidate.clientId, requestId)
    })
  }

  /** A client's `location-reply`. One for a request already settled is ignored. */
  answer(clientId: string, requestId: string, answer: LocationAnswer): void {
    const request = this.pending.get(requestId)
    if (!request) return
    request.tally.record(clientId, answer)
    const outcome = request.tally.outcome()
    if (outcome) request.settle(outcome)
  }

  /** A client went away: it will not answer anything it was asked. */
  disconnected(clientId: string): void {
    for (const requestId of [...this.pending.keys()]) {
      this.answer(clientId, requestId, { ok: false, error: 'disconnected before answering' })
    }
  }
}
