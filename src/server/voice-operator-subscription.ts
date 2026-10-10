import type { SpeechResponse, SubscriberRegistration } from './voice-operator'

/**
 * Keeps Spaceterm registered with Voice Operator as the route for command
 * dictations and a listener for dictation start/end, so Voice Operator needs to
 * know nothing about Spaceterm: no socket path, no name.
 *
 * Voice Operator saves registrations, so one call would do — except that either
 * side can start without the other, and a socket path can change. So this
 * registers at startup and again whenever a *different* Voice Operator
 * process appears (its discovery file names a new pid), and retries while the
 * last attempt failed. Each check is one small file read; the HTTP call only
 * happens when something changed.
 */

export const SUBSCRIBER_NAME = 'spaceterm'

export interface VoiceOperatorSubscriptionDeps {
  /** Voice Operator's discovery document, or undefined when it is not running. */
  readDiscovery(): { pid?: unknown } | undefined
  subscribe(name: string, registration: SubscriberRegistration): Promise<SpeechResponse>
  log(message: string): void
}

export class VoiceOperatorSubscription {
  /** The Voice Operator pid this process last registered with successfully. */
  private registeredWith: number | undefined
  /** Set while a call is in flight, so overlapping checks don't stack up calls. */
  private inFlight = false
  /** Logged once per Voice Operator process, not every check. */
  private reportedFor: number | undefined

  constructor(
    private readonly registration: SubscriberRegistration,
    private readonly deps: VoiceOperatorSubscriptionDeps,
  ) {}

  /** Register if a Voice Operator is up that this process has not registered with. */
  async check(): Promise<void> {
    const pid = this.deps.readDiscovery()?.pid
    if (typeof pid !== 'number' || pid === this.registeredWith || this.inFlight) return
    this.inFlight = true
    try {
      const response = await this.deps.subscribe(SUBSCRIBER_NAME, this.registration)
      if (response?.status === 200) {
        this.registeredWith = pid
        this.deps.log(`[voice-operator] registered as ${SUBSCRIBER_NAME} (pid ${pid}) for commands and dictation events`)
      } else if (this.reportedFor !== pid) {
        this.reportedFor = pid
        this.deps.log(response?.status === 404
          ? `[voice-operator] pid ${pid} predates /v1/subscribers; command dictations will not reach Spaceterm`
          : `[voice-operator] registering with pid ${pid} failed (${response ? `HTTP ${response.status}` : 'unreachable'}); retrying`)
      }
    } finally {
      this.inFlight = false
    }
  }
}
