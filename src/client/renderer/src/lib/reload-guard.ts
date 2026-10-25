/**
 * Work on the page that a reload would throw away, held for as long as it
 * runs: a phone dictation still being spoken, or still being sent. A reload
 * the page wants for itself (install-api.ts's resync after a reconnect) waits
 * for every hold to be let go; it used to take the microphone and the audio
 * kept for resending with it (October 2026).
 *
 * The waiters run a turn after the last hold goes, so whatever the work's own
 * caller does with its result — a transcript put in the composer, words sent
 * to Control — happens first.
 */
export class ReloadGuard {
  private holds = 0
  private waiters: Array<() => void> = []

  /** Whether anything holds the page now. */
  get held(): boolean {
    return this.holds > 0
  }

  /** Hold the page; returns the let-go, which may be called any number of times. */
  hold(): () => void {
    this.holds++
    let released = false
    return () => {
      if (released) return
      released = true
      this.holds--
      if (this.holds === 0) setTimeout(() => this.wake(), 0)
    }
  }

  /** Resolves once nothing holds the page. */
  free(): Promise<void> {
    if (!this.held) return Promise.resolve()
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  private wake(): void {
    // Held again in the meantime: wait for that to go too.
    if (this.held) return
    this.waiters.splice(0).forEach((resolve) => resolve())
  }
}

/** The page's one guard. */
export const reloadGuard = new ReloadGuard()
