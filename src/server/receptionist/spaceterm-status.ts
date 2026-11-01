/**
 * What Spaceterm itself is waiting on the user to do — restart the server,
 * install a newer iPhone app, or refresh the phone's page — told to Control as
 * it changes, so that Control can say so instead of the user having to notice
 * the rocket menu's sparks. The same three the rocket menu shows, by the same
 * rule (src/shared/pending-updates.ts), from what each phone reports
 * (`app-behind`) and the server's restart flag: see `spacetermStatus` in
 * src/server/index.ts.
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
import { pendingUpdates } from '../../shared/pending-updates'

export interface SpacetermStatus {
  /** `npm run flag-restart` was run, and the server has not restarted since: see restart-flag.ts. */
  restartPending: boolean
  /** A phone reports its app older than the Mac's source: only an install from the Mac fixes it. */
  phoneInstallPending: boolean
  /** A phone reports its page older than the Mac's latest build, with nothing pending that reloads it anyway: a refresh fixes it. */
  reloadPending: boolean
}

/** The status as sampled, with where the user is: said alongside, never a reason to tell. */
export interface StatusSample extends SpacetermStatus {
  /** The device holding Control, e.g. "Mac" or "Phone"; undefined when none does. */
  device?: string
}

/**
 * What is pending, from the restart flag and what each device last said is
 * behind: each device's by the rule its rocket menu shows, and pending if it
 * is for any of them.
 */
export function pendingStatus(restart: boolean, devices: Iterable<{ native: boolean; web: boolean }>): SpacetermStatus {
  const pending = [...devices].map(behind => pendingUpdates({ restart, ...behind }))
  return {
    restartPending: restart,
    phoneInstallPending: pending.some(p => p.install),
    reloadPending: pending.some(p => p.reload),
  }
}

/** What a session that has been told nothing knows: that nothing is pending. */
export const NOTHING_PENDING: SpacetermStatus = { restartPending: false, phoneInstallPending: false, reloadPending: false }

const KEYS = ['restartPending', 'phoneInstallPending', 'reloadPending'] as const satisfies ReadonlyArray<keyof SpacetermStatus>

export function statusOf(sample: StatusSample): SpacetermStatus {
  return { restartPending: sample.restartPending, phoneInstallPending: sample.phoneInstallPending, reloadPending: sample.reloadPending }
}

export function sameStatus(a: SpacetermStatus, b: SpacetermStatus): boolean {
  return KEYS.every(key => a[key] === b[key])
}

function anyPending(status: SpacetermStatus): boolean {
  return KEYS.some(key => status[key])
}

/**
 * A status as saved with an earlier session, or undefined if it is not one.
 * One saved before refreshes were told has no `reloadPending`: none was told.
 */
export function parseStatus(value: unknown): SpacetermStatus | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const status = value as Partial<Record<keyof SpacetermStatus, unknown>>
  if (typeof status.restartPending !== 'boolean' || typeof status.phoneInstallPending !== 'boolean') return undefined
  if (status.reloadPending !== undefined && typeof status.reloadPending !== 'boolean') return undefined
  return { restartPending: status.restartPending, phoneInstallPending: status.phoneInstallPending, reloadPending: status.reloadPending ?? false }
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
    now.reloadPending
      ? '- Page refresh: pending. The phone\'s page is older than the Mac\'s latest build; refreshing the pages loads the new one.'
      : `- Page refresh: not needed${told.reloadPending ? ' any more; the page has been refreshed, or something else now brings it up to date' : ''}.`,
  ]
  if (now.device) lines.push(`The user is on the ${now.device}.`)
  const became = KEYS.some(key => now[key] && !told[key])
  lines.push(became
    ? 'Tell the user what has just become pending, once and briefly, when it will not interrupt: if you are in the middle of a topic, put it on your backlog instead. ' +
      'A server restart matters wherever they are. An iPhone install or a page refresh matters only while they are using the phone: on the Mac, mention it only if they ask, or alongside a restart. ' +
      'A page refresh is the smallest of the three, so say it in a few words. ' +
      'Do not bring any of them up again unless they ask, and never restart, install or refresh anything unless the user explicitly asks you to: ' +
      'then use restart_server, install_phone_app or refresh_clients.'
    : anyPending(now)
      ? 'Nothing has become pending since you were last told, so this is a reminder, not news: do not bring it up unless they ask.'
      : 'Nothing needs doing, so there is nothing to tell the user about this unless they ask.')
  return lines.join('\n')
}
