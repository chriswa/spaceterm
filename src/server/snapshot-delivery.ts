import type { PtySessionId } from '../shared/ids'

/**
 * Who gets a terminal's `snapshot` frames.
 *
 * A client asks for a session's snapshots (`set-terminal-mode`) once per card
 * on its canvas, and on the phone that is every terminal, all the time. A
 * client can also *pause its canvas* (`canvas-pause`): the phone does while
 * Control's transcript covers it or the screen is off, when nothing it
 * receives could be drawn. Snapshots are latest-wins, so a paused client's are
 * dropped rather than queued, and on resume it gets each subscribed screen as
 * it now stands — the only one of all the dropped frames that mattered.
 */
export interface SnapshotSubscriber {
  subscriptions: ReadonlyMap<PtySessionId, 'live' | 'snapshot'>
  /** Set by `canvas-pause`. Not remembered across a reconnect. */
  canvasPaused?: boolean
}

export function receivesSnapshots(client: SnapshotSubscriber, sessionId: PtySessionId): boolean {
  return client.subscriptions.get(sessionId) === 'snapshot' && !client.canvasPaused
}

/** The sessions whose current screen a client resuming its canvas is owed. */
export function owedOnResume(client: SnapshotSubscriber): PtySessionId[] {
  return [...client.subscriptions].filter(([, mode]) => mode === 'snapshot').map(([id]) => id)
}
