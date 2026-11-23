/**
 * Control's scheduled prompts: its CronCreate, CronList and CronDelete, kept
 * on disk.
 *
 * The user asks Control for alarms and reminders ("remind me at three to
 * check on Kevin", "set an alarm for twenty minutes"). Claude Code already
 * gives its own sessions exactly this, as cron jobs made with CronCreate,
 * listed with CronList and cancelled with CronDelete, and the model has been
 * trained on those tools. So Control's are the same tools, with the same
 * names, fields and meaning — a five-field cron in local time, a prompt, and
 * `recurring` (default true, one-shot when false) — rather than an alarm
 * vocabulary of its own that the model would have to learn from the prompt
 * alone. Where Control's differ, it is in what Control needs:
 *
 * - A job is durable. Claude Code's live in the session and go with it;
 *   Control's session is compacted and replaced, and the server restarts
 *   often, and a reminder is a promise to the user. `durable` is accepted and
 *   changes nothing, as in Claude Code, where it is the other way round.
 * - A job fires as news (`scheduled-prompt`), not as a prompt typed into the
 *   session: news is what Control already knows how to tell, or hold for when
 *   the user is back.
 * - No jitter. Claude Code's spreads its fleet's load on the API; this
 *   spreads nothing, and a reminder for 3:00 should not come at 2:58.
 *
 * Times are computed in the Mac's UTC offset, read fresh from the Mac
 * (`utcOffsetMinutes` in current-time.ts), never Node's own zone, which can lag
 * the Mac's by an hour: see current-time.ts.
 */
import { randomBytes } from 'crypto'
import * as path from 'path'
import { Cron } from 'croner'
import { SOCKET_DIR } from '../../shared/protocol'
import { serverLog } from '../server-log'
import { fileStore, type NameRegistryStore } from './name-registry'

export const CRON_JOBS_FILE = path.join(SOCKET_DIR, 'receptionist', 'cron-jobs.json')

/** A recurring job fires a last time and is deleted this long after it was made, as Claude Code's do. */
export const RECURRING_EXPIRY_MS = 7 * 24 * 60 * 60_000
/** The most jobs kept at once. */
export const MAX_CRON_JOBS = 50
/**
 * The furthest ahead a one-shot job may first fire. A one-shot pins its day
 * and month, so a time already past today next matches a year on: refused,
 * rather than kept silently for a year.
 */
export const ONE_SHOT_HORIZON_MS = 300 * 24 * 60 * 60_000
/** A fire this much later than it was due — the server was down — says how late it is. */
export const LATE_MS = 60_000

export interface CronJob {
  /** Eight hex digits, as CronCreate's job ids. */
  id: string
  cron: string
  prompt: string
  recurring: boolean
  /** Epoch ms. */
  createdAt: number
  /** When it next fires, epoch ms. */
  nextAt: number
}

/** A job that has come due, as told to Control. */
export interface FiredJob {
  job: CronJob
  /** When it was due, epoch ms: `nextAt` as it was. */
  dueAt: number
  /** It will not fire again: a one-shot, or a recurring job at its expiry. */
  final: boolean
}

export type CreateResult = { ok: true; job: CronJob } | { ok: false; error: string }

/** A five-field cron's next match strictly after `after`, in a zone `offsetMinutes` east of UTC; undefined if it never matches again. */
export function nextMatch(cron: string, after: number, offsetMinutes: number): number | undefined {
  const next = new Cron(cron, { paused: true, utcOffset: offsetMinutes, legacyMode: true }).nextRun(new Date(after))
  return next ? next.getTime() : undefined
}

/** Why a cron is not a five-field expression croner can schedule, or undefined if it is. */
export function cronProblem(cron: string): string | undefined {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return `"cron" must be five fields, "minute hour day-of-month month day-of-week", such as "30 14 23 11 *"; "${cron}" has ${fields.length}`
  try {
    new Cron(cron, { paused: true })
    return undefined
  } catch (err) {
    return `"${cron}" is not a valid cron expression: ${err instanceof Error ? err.message : String(err)}`
  }
}

export class CronJobs {
  private readonly jobs = new Map<string, CronJob>()
  private readonly store: NameRegistryStore

  constructor(deps: { store?: NameRegistryStore } = {}) {
    this.store = deps.store ?? fileStore(CRON_JOBS_FILE)
    this.load()
  }

  /** CronCreate. `offsetMinutes`: the Mac's offset east of UTC now. */
  create(spec: { cron: string; prompt: string; recurring: boolean }, offsetMinutes: number, now = Date.now()): CreateResult {
    const problem = cronProblem(spec.cron)
    if (problem) return { ok: false, error: problem }
    if (this.jobs.size >= MAX_CRON_JOBS) return { ok: false, error: `there are already ${MAX_CRON_JOBS} jobs; delete some with CronDelete first` }
    const cron = spec.cron.trim().split(/\s+/).join(' ')
    const nextAt = nextMatch(cron, now, offsetMinutes)
    if (nextAt === undefined) return { ok: false, error: `"${cron}" never matches a time from now on` }
    if (!spec.recurring && nextAt - now > ONE_SHOT_HORIZON_MS) {
      return { ok: false, error: `"${cron}" next matches more than ${Math.round(ONE_SHOT_HORIZON_MS / 86_400_000)} days from now, so the time it pins has probably already passed this year; check the date with current_time` }
    }
    let id: string
    do id = randomBytes(4).toString('hex'); while (this.jobs.has(id))
    const job: CronJob = { id, cron, prompt: spec.prompt, recurring: spec.recurring, createdAt: now, nextAt }
    this.jobs.set(id, job)
    this.save()
    return { ok: true, job }
  }

  /** CronDelete. Returns the job deleted, or undefined if there was none by that id. */
  delete(id: string): CronJob | undefined {
    const job = this.jobs.get(id.trim().toLowerCase())
    if (!job) return undefined
    this.jobs.delete(job.id)
    this.save()
    return job
  }

  /** CronList: every job, soonest first. */
  list(): CronJob[] {
    return [...this.jobs.values()].sort((a, b) => a.nextAt - b.nextAt)
  }

  /** When the soonest job fires, if any. */
  nextDue(): number | undefined {
    return this.list()[0]?.nextAt
  }

  /**
   * Every job due by `now`, each fired once however many of its times were
   * missed: one-shots deleted, recurring jobs moved on to their next match
   * after `now`, or deleted at their expiry, as Claude Code's are.
   */
  fireDue(offsetMinutes: number, now = Date.now()): FiredJob[] {
    const fired: FiredJob[] = []
    for (const job of this.list()) {
      if (job.nextAt > now) break
      const dueAt = job.nextAt
      const next = job.recurring ? nextMatch(job.cron, now, offsetMinutes) : undefined
      const final = next === undefined || next > job.createdAt + RECURRING_EXPIRY_MS
      if (final) this.jobs.delete(job.id)
      else this.jobs.set(job.id, { ...job, nextAt: next })
      fired.push({ job, dueAt, final })
    }
    if (fired.length) this.save()
    return fired
  }

  private load(): void {
    const raw = this.store.load()
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as { jobs?: unknown }
      if (!Array.isArray(parsed.jobs)) return
      for (const job of parsed.jobs as Array<Partial<CronJob>>) {
        if (typeof job?.id !== 'string' || typeof job.cron !== 'string' || typeof job.prompt !== 'string' ||
          typeof job.recurring !== 'boolean' || typeof job.createdAt !== 'number' || typeof job.nextAt !== 'number') continue
        this.jobs.set(job.id, { id: job.id, cron: job.cron, prompt: job.prompt, recurring: job.recurring, createdAt: job.createdAt, nextAt: job.nextAt })
      }
    } catch {
      // A corrupt file is nothing scheduled, not a server that will not start.
    }
  }

  /** Best-effort: a failed write must not throw out of a turn. */
  private save(): void {
    try {
      this.store.save(JSON.stringify({ jobs: this.list() }))
    } catch (err) {
      serverLog(`[receptionist] failed to save cron jobs: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/**
 * When a job fires, as Control should say it: the Mac's wall clock at
 * `offsetMinutes`, and how long from `now`, such as
 * "Monday, November 23 at 3:00 PM, in 20 minutes".
 */
export function whenWords(at: number, offsetMinutes: number, now = Date.now()): string {
  const local = new Date(at + offsetMinutes * 60_000)
  const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][local.getUTCDay()]
  const month = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][local.getUTCMonth()]
  const hours = local.getUTCHours()
  const clock = `${hours % 12 || 12}:${String(local.getUTCMinutes()).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`
  return `${weekday}, ${month} ${local.getUTCDate()} at ${clock}, ${relativeWords(at - now)}`
}

/** "in 20 minutes", "in 2 hours 5 minutes", "in 3 days"; "now" within the minute; "5 minutes ago" past. */
export function relativeWords(ms: number): string {
  const past = ms < 0
  const minutes = Math.round(Math.abs(ms) / 60_000)
  if (minutes === 0) return 'now'
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`
  const span = minutes < 60 ? plural(minutes, 'minute')
    : minutes < 48 * 60 ? [plural(Math.floor(minutes / 60), 'hour'), ...(minutes % 60 ? [plural(minutes % 60, 'minute')] : [])].join(' ')
      : plural(Math.round(minutes / 1440), 'day')
  return past ? `${span} ago` : `in ${span}`
}

/** One job as CronList and CronCreate tell the model of it. */
export function describeJob(job: CronJob, offsetMinutes: number, now = Date.now()): string {
  const kind = job.recurring
    ? `recurring, expires ${whenWords(job.createdAt + RECURRING_EXPIRY_MS, offsetMinutes, now).replace(/, in .*$|, now$/, '')}`
    : 'one-shot'
  return `${job.id}: cron "${job.cron}" (${kind}), next fires ${whenWords(job.nextAt, offsetMinutes, now)}; prompt: ${job.prompt}`
}
