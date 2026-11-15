import { execFile } from 'child_process'
import { readlinkSync } from 'fs'

/**
 * The current_time tool: the date and time where the Mac is, as Control
 * should read them aloud.
 *
 * Control has no clock of its own, so without this a question as small as
 * "what's the date?" sent it off to spawn an agent.
 *
 * The Mac's own `date` is asked rather than Node's `Intl`, for two reasons:
 *
 * - Node bundles its own copy of the time zone rules in ICU, which lags the
 *   Mac's. Node 24's is tzdata 2026a, from before British Columbia moved to
 *   permanent UTC-7 (tzdata 2026b), so after 1 November 2026 it puts Vancouver
 *   an hour behind the Mac's clock, calling it PST at UTC-8.
 * - Node reads the zone once, at startup, so a long-running server would keep
 *   the old zone after the user travels and the Mac changes its own.
 *
 * `date` reads `/etc/localtime` and the Mac's tz database on every call, so
 * both follow the Mac. The zone's name comes from where that link points.
 */

const DATE_TIMEOUT_MS = 5_000
/** Fields `|`-separated, so the words are put together here rather than by `date`'s padding rules. */
const DATE_FORMAT = '+%A|%B|%d|%Y|%I|%M|%p|%Z|%z'

export interface ClockProbes {
  /** `date` run with `format`, its output as printed. */
  date(format: string): Promise<string>
  /** Where `/etc/localtime` points, such as `/var/db/timezone/zoneinfo/America/Vancouver`. Throws when it is not a link. */
  zoneLink(): string
}

export const REAL_CLOCK_PROBES: ClockProbes = {
  date: (format) => new Promise((resolve, reject) => {
    execFile('/bin/date', [format], { timeout: DATE_TIMEOUT_MS }, (err, stdout) => {
      if (err) reject(new Error(`could not run date: ${err.message}`))
      else resolve(stdout)
    })
  }),
  zoneLink: () => readlinkSync('/etc/localtime'),
}

/** The zone's tz name, such as `America/Vancouver`, from what `/etc/localtime` links to; undefined when it cannot tell. */
export function zoneName(link: string): string | undefined {
  const match = /zoneinfo\/(.+)$/.exec(link)
  return match?.[1]
}

/** `date`'s fields, as DATE_FORMAT prints them, in words: "Sunday, November 15, 2026, 12:27 PM". */
export function describeDateFields(printed: string): { when: string; abbreviation: string; offset: string } {
  const fields = printed.trim().split('|')
  if (fields.length !== 9) throw new Error(`date printed "${printed.trim()}", not the fields asked for`)
  const [weekday, month, day, year, hour, minute, ampm, abbreviation, offset] = fields
  const unpad = (n: string) => String(Number(n))
  return {
    when: `${weekday}, ${month} ${unpad(day)}, ${year}, ${unpad(hour)}:${minute} ${ampm}`,
    abbreviation,
    // "-0700" as "UTC-07:00", which reads unambiguously.
    offset: /^[+-]\d{4}$/.test(offset) ? `UTC${offset.slice(0, 3)}:${offset.slice(3)}` : offset,
  }
}

/** What current_time tells the model. Rejects with why it could not read the clock. */
export async function currentTime(probes: ClockProbes = REAL_CLOCK_PROBES): Promise<string> {
  const { when, abbreviation, offset } = describeDateFields(await probes.date(DATE_FORMAT))
  let zone: string | undefined
  try {
    zone = zoneName(probes.zoneLink())
  } catch {
    zone = undefined
  }
  const named = zone ? `the Mac's time zone, ${zone}` : 'the Mac\'s time zone'
  return `${when}, in ${named} (${abbreviation}, ${offset})`
}
