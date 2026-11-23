import { describe, expect, it } from 'vitest'
import { CronJobs, cronProblem, describeJob, nextMatch, ONE_SHOT_HORIZON_MS, RECURRING_EXPIRY_MS, relativeWords, whenWords } from './cron-jobs'
import type { NameRegistryStore } from './name-registry'

function memoryStore(): NameRegistryStore {
  let json: string | undefined
  return { load: () => json, save: (next) => { json = next } }
}

/** UTC-7, Vancouver's offset once it kept summer time for good. */
const VANCOUVER = -420
/** Monday, November 23, 2026, 1:00 PM in Vancouver. */
const NOW = Date.parse('2026-11-23T20:00:00Z')

describe('nextMatch', () => {
  it('reads the cron in the Mac\'s offset, not Node\'s zone', () => {
    expect(new Date(nextMatch('0 15 * * *', NOW, VANCOUVER)!).toISOString()).toBe('2026-11-23T22:00:00.000Z')
    expect(new Date(nextMatch('0 15 * * *', NOW, 60)!).toISOString()).toBe('2026-11-24T14:00:00.000Z')
  })

  it('is strictly after the time given', () => {
    expect(nextMatch('0 13 * * *', NOW, VANCOUVER)).toBe(NOW + 24 * 60 * 60_000)
  })
})

describe('cronProblem', () => {
  it('takes five fields only, as CronCreate does', () => {
    expect(cronProblem('*/5 * * * *')).toBeUndefined()
    expect(cronProblem('0 0 15 * * *')).toContain('must be five fields')
    expect(cronProblem('61 * * * *')).toContain('not a valid cron expression')
  })
})

describe('CronJobs', () => {
  it('a one-shot fires once at its time, then is gone', () => {
    const jobs = new CronJobs({ store: memoryStore() })
    const made = jobs.create({ cron: '20 13 23 11 *', prompt: 'Tea is ready.', recurring: false }, VANCOUVER, NOW)
    if (!made.ok) throw new Error(made.error)
    expect(made.job.id).toMatch(/^[0-9a-f]{8}$/)
    expect(made.job.nextAt).toBe(NOW + 20 * 60_000)
    expect(jobs.fireDue(VANCOUVER, NOW + 19 * 60_000)).toEqual([])
    expect(jobs.fireDue(VANCOUVER, NOW + 20 * 60_000)).toEqual([{ job: made.job, dueAt: made.job.nextAt, final: true }])
    expect(jobs.list()).toEqual([])
  })

  it('refuses a one-shot whose pinned time has already passed this year', () => {
    const jobs = new CronJobs({ store: memoryStore() })
    const made = jobs.create({ cron: '0 9 23 11 *', prompt: 'Too late.', recurring: false }, VANCOUVER, NOW)
    expect(made.ok).toBe(false)
    expect(!made.ok && made.error).toContain('already passed this year')
    // The same pinned time is fine as a recurring job, which waits for next year.
    expect(jobs.create({ cron: '0 9 23 11 *', prompt: 'Yearly.', recurring: true }, VANCOUVER, NOW).ok).toBe(true)
    expect(ONE_SHOT_HORIZON_MS).toBeLessThan(365 * 86_400_000)
  })

  it('a recurring job moves on to its next time, once however many it missed, and expires after seven days', () => {
    const jobs = new CronJobs({ store: memoryStore() })
    const made = jobs.create({ cron: '7 * * * *', prompt: 'Hourly.', recurring: true }, VANCOUVER, NOW)
    if (!made.ok) throw new Error(made.error)
    const threeHoursOn = NOW + 3 * 60 * 60_000
    const fired = jobs.fireDue(VANCOUVER, threeHoursOn)
    expect(fired).toHaveLength(1)
    expect(fired[0].final).toBe(false)
    expect(jobs.list()[0].nextAt).toBe(threeHoursOn + 7 * 60_000)
    const last = jobs.fireDue(VANCOUVER, NOW + RECURRING_EXPIRY_MS - 30 * 60_000)
    expect(last.map(job => job.final)).toEqual([true])
    expect(jobs.list()).toEqual([])
  })

  it('keeps its jobs on disk, for the next server, and cancels by id', () => {
    const store = memoryStore()
    const made = new CronJobs({ store }).create({ cron: '0 15 * * *', prompt: 'Check on Kevin.', recurring: false }, VANCOUVER, NOW)
    if (!made.ok) throw new Error(made.error)
    const next = new CronJobs({ store })
    expect(next.list()).toEqual([made.job])
    expect(next.delete('nope')).toBeUndefined()
    expect(next.delete(made.job.id.toUpperCase())).toEqual(made.job)
    expect(new CronJobs({ store }).list()).toEqual([])
  })

  it('takes a corrupt file for no jobs', () => {
    expect(new CronJobs({ store: { load: () => '{not json', save: () => {} } }).list()).toEqual([])
  })
})

describe('whenWords', () => {
  it('says the Mac\'s wall clock and how long from now', () => {
    expect(whenWords(NOW + 20 * 60_000, VANCOUVER, NOW)).toBe('Monday, November 23 at 1:20 PM, in 20 minutes')
    expect(whenWords(NOW + 26 * 60 * 60_000, VANCOUVER, NOW)).toBe('Tuesday, November 24 at 3:00 PM, in 26 hours')
    expect(relativeWords(-5 * 60_000)).toBe('5 minutes ago')
    expect(relativeWords(125 * 60_000)).toBe('in 2 hours 5 minutes')
    expect(relativeWords(10_000)).toBe('now')
  })

  it('describes a job as CronList shows it', () => {
    const jobs = new CronJobs({ store: memoryStore() })
    const made = jobs.create({ cron: '0 15 * * *', prompt: 'Check on Kevin.', recurring: false }, VANCOUVER, NOW)
    if (!made.ok) throw new Error(made.error)
    expect(describeJob(made.job, VANCOUVER, NOW))
      .toBe(`${made.job.id}: cron "0 15 * * *" (one-shot), next fires Monday, November 23 at 3:00 PM, in 2 hours; prompt: Check on Kevin.`)
  })
})
