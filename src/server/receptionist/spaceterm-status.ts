/**
 * What Spaceterm itself is waiting on the user to do — restart the server, or
 * install a newer iPhone app — told to Control as it changes, so that Control
 * can say so instead of the user having to notice a marching Restart or
 * Install button.
 *
 * Control has no way to be given something for one message only: every
 * message goes into its Claude Code session for good, and the daemon takes
 * nothing per turn but the prompt. So the status is sampled as each message
 * leaves (`Receptionist.ask`), and goes on it only when it differs from what
 * the session was last told — never on every turn. What it was last told is
 * kept with the session (`SavedSession.toldStatus`), so a server restart
 * neither repeats it nor forgets that a restart was pending. It goes on the
 * message alone, never into the record (conversation.jsonl), so the
 * transcript view never shows it among the user's words.
 */

export interface SpacetermStatus {
  /** `npm run flag-restart` was run, and the server has not restarted since: see restart-flag.ts. */
  restartPending: boolean
  /** A phone reports its app older than the Mac's source: only an install from the Mac fixes it. */
  phoneInstallPending: boolean
}

/** The status as sampled, with where the user is: said alongside, never a reason to tell. */
export interface StatusSample extends SpacetermStatus {
  /** The device holding Control, e.g. "Mac" or "Phone"; undefined when none does. */
  device?: string
}

/** What a session that has been told nothing knows: that nothing is pending. */
export const NOTHING_PENDING: SpacetermStatus = { restartPending: false, phoneInstallPending: false }

export function statusOf(sample: StatusSample): SpacetermStatus {
  return { restartPending: sample.restartPending, phoneInstallPending: sample.phoneInstallPending }
}

export function sameStatus(a: SpacetermStatus, b: SpacetermStatus): boolean {
  return a.restartPending === b.restartPending && a.phoneInstallPending === b.phoneInstallPending
}

function anyPending(status: SpacetermStatus): boolean {
  return status.restartPending || status.phoneInstallPending
}

export const STATUS_HEADING = 'SPACETERM STATUS'

/**
 * The status section for the next message, or undefined when the session
 * already knows it. `told` is what the session was last told. `forgot`: the
 * session has just been compacted, and its summary may have dropped or kept a
 * pending item — so one is told again even though nothing changed.
 */
export function statusToTell(now: StatusSample, told: SpacetermStatus = NOTHING_PENDING, forgot = false): string | undefined {
  if (sameStatus(now, told) && !(forgot && anyPending(told))) return undefined
  return renderStatus(now, told)
}

export function renderStatus(now: StatusSample, told: SpacetermStatus): string {
  const lines = [
    `${STATUS_HEADING}, from the Spaceterm system itself, not from the user: the user did not say this, and it is not part of what they said. ` +
    'It is sent only when something changes, so it stays true until the next one.',
    now.restartPending
      ? '- Server restart: pending. Changes were made that take effect only once the user restarts the Spaceterm server.'
      : `- Server restart: not needed${told.restartPending ? ' any more; the restart has been done' : ''}.`,
    now.phoneInstallPending
      ? '- iPhone app install: pending. A newer iPhone app is waiting to be installed on the phone from the Mac.'
      : `- iPhone app install: not needed${told.phoneInstallPending ? ' any more; the new app is installed' : ''}.`,
  ]
  if (now.device) lines.push(`The user is on the ${now.device}.`)
  const became = (now.restartPending && !told.restartPending) || (now.phoneInstallPending && !told.phoneInstallPending)
  lines.push(became
    ? 'Tell the user what has just become pending, once and briefly, when it will not interrupt: if you are in the middle of a topic, put it on your backlog instead. ' +
      'A server restart matters wherever they are. An iPhone install matters only while they are using the phone: on the Mac, mention it only if they ask, or alongside a restart. ' +
      'Do not bring either up again unless they ask, and never restart or install anything yourself.'
    : anyPending(now)
      ? 'Nothing has become pending since you were last told, so this is a reminder, not news: do not bring it up unless they ask.'
      : 'Nothing needs doing, so there is nothing to tell the user about this unless they ask.')
  return lines.join('\n')
}
