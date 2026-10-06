import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import type { UsageBar, UsagePalette, UsageSnapshot } from '../shared/usage-report'
import { serverLog } from './server-log'

const execFileAsync = promisify(execFile)

/**
 * AI usage from AI Spend Tracker (~/claude-usage-tracker), for the phone's
 * corner readout.
 *
 * The tracker is a menu-bar app that fetches every provider's rate-limit
 * windows every five minutes. Its binary with `--json` prints what the running
 * app last saved — it never fetches — so polling it is cheap, and each
 * reading says when it was taken. A poll is timed for when the newest reading
 * will be 5½ minutes old: the tracker's next fetch has landed by then, so a
 * fresh reading arrives about as soon as one exists, with one run per fetch.
 */

/** The tracker refreshes every 5 minutes; give its fetch 30 seconds to land. */
export const POLL_AFTER_READING_MS = 5.5 * 60_000
/** A reading already that old means the tracker is behind or stopped: check back at this pace. */
export const STALE_RETRY_MS = 60_000
/** When the tracker cannot be run at all. */
export const FAILED_RETRY_MS = 10 * 60_000

const APP_BINARY = 'Contents/MacOS/AISpendTracker'
/** Where the app usually lives, for when it is not running: installed, or built from source. */
const APP_CANDIDATES = [
  join('/Applications', 'AI Spend Tracker.app', APP_BINARY),
  join(homedir(), 'claude-usage-tracker', 'build', 'AI Spend Tracker.app', APP_BINARY)
]

// ─── the tracker's report (src: UsageReport.swift), as far as the bars need it ───

interface TrackerWindow { caption: string; usagePercent: number; elapsedPercent: number; modelScoped: boolean; resetsAt?: string }
interface TrackerProvider { id: string; name: string; updatedAt?: string; error?: string; windows: TrackerWindow[] }
interface TrackerReport {
  providers: TrackerProvider[]
  spend?: { monthToDateUSD: number; budgetUSD?: number; percentOfBudget?: number; monthElapsedPercent: number; resetsAt?: string }
}

/** An ISO time as ms since epoch, or undefined if absent or unreadable. */
function epoch(iso: string | undefined): number | undefined {
  const at = iso ? Date.parse(iso) : NaN
  return Number.isFinite(at) ? at : undefined
}

const PROVIDER_PALETTES: Record<string, UsagePalette> = { claude: 'claude', codex: 'codex', cursor: 'cursor', devin: 'devin', jev: 'jev' }

/**
 * The bars the tray draws, in its order: each provider's windows (or one
 * warning if its fetch failed), then spend. Mirrors `PieChart.circles`.
 */
export function usageSnapshotFrom(report: TrackerReport): UsageSnapshot {
  const bars: UsageBar[] = []
  let updatedAt: number | null = null
  for (const p of report.providers) {
    const palette = PROVIDER_PALETTES[p.id] ?? 'claude'
    const at = epoch(p.updatedAt)
    if (at !== undefined) updatedAt = Math.max(updatedAt ?? at, at)
    if (p.error) {
      bars.push({ label: `${p.name} unavailable`, palette, error: true, usage: 0, time: 0, startsGroup: true })
      continue
    }
    p.windows.forEach((w, i) => bars.push({
      label: `${p.name} ${w.caption}`,
      palette: w.modelScoped ? 'scoped' : palette,
      usage: Math.max(0, w.usagePercent / 100),
      time: Math.min(1, Math.max(0, w.elapsedPercent / 100)),
      resetsAt: epoch(w.resetsAt),
      startsGroup: i === 0
    }))
  }
  const spend = report.spend
  if (spend) {
    // With no budget, any spend fills the bar (UsageMath.spendFraction).
    const usage = spend.percentOfBudget !== undefined ? spend.percentOfBudget / 100 : spend.monthToDateUSD > 0 ? 1 : 0
    bars.push({ label: `Spend $${spend.monthToDateUSD.toFixed(0)}`, palette: 'spend', usage, time: spend.monthElapsedPercent / 100, resetsAt: epoch(spend.resetsAt), startsGroup: true })
  }
  return { bars, updatedAt }
}

/** How long until the next poll, given the snapshot just read (or null if reading failed). */
export function nextPollDelay(snapshot: UsageSnapshot | null, now: number): number {
  if (!snapshot) return FAILED_RETRY_MS
  if (snapshot.updatedAt === null) return STALE_RETRY_MS
  return Math.max(STALE_RETRY_MS, snapshot.updatedAt + POLL_AFTER_READING_MS - now)
}

export interface UsageTrackerDeps {
  /** The tracker's JSON report, or null when it cannot be run. */
  read(): Promise<string | null>
  now(): number
  schedule(fn: () => void, ms: number): () => void
}

/**
 * The running tracker's binary, wherever its checkout is. `--json` reads what
 * the running app saved, so its own binary is the one to ask.
 */
async function runningTrackerBinary(): Promise<string | null> {
  try {
    const { stdout: pids } = await execFileAsync('pgrep', ['-x', 'AISpendTracker'], { timeout: 5_000 })
    const pid = pids.split('\n')[0]?.trim()
    if (!pid) return null
    const { stdout: path } = await execFileAsync('ps', ['-p', pid, '-o', 'comm='], { timeout: 5_000 })
    return path.trim() || null
  } catch {
    return null // pgrep exits 1 when nothing matches
  }
}

let reportedMissing = false

async function readTracker(): Promise<string | null> {
  const binary = process.env.SPACETERM_AI_SPEND ?? await runningTrackerBinary() ?? APP_CANDIDATES.find((p) => existsSync(p))
  if (!binary) {
    if (!reportedMissing) serverLog('[usage] AI Spend Tracker is not running and not at any known path')
    reportedMissing = true
    return null
  }
  reportedMissing = false
  try {
    const { stdout } = await execFileAsync(binary, ['--json'], { timeout: 15_000, maxBuffer: 1024 * 1024 })
    return stdout
  } catch (err) {
    serverLog(`[usage] ${binary} --json failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

const REAL_DEPS: UsageTrackerDeps = {
  read: readTracker,
  now: () => Date.now(),
  schedule: (fn, ms) => {
    const timer = setTimeout(fn, ms)
    timer.unref()
    return () => clearTimeout(timer)
  }
}

export class UsageTracker {
  private snapshot: UsageSnapshot | null = null
  private cancel: (() => void) | null = null
  private stopped = false

  constructor(
    /** A snapshot that differs from the last one. */
    private readonly onChange: (snapshot: UsageSnapshot) => void,
    private readonly deps: UsageTrackerDeps = REAL_DEPS
  ) {}

  current(): UsageSnapshot | null {
    return this.snapshot
  }

  start(): void {
    void this.poll()
  }

  stop(): void {
    this.stopped = true
    this.cancel?.()
  }

  /** One read, then the next one scheduled from it. Exposed for tests. */
  async poll(): Promise<void> {
    this.cancel = null
    let next: UsageSnapshot | null = null
    const raw = await this.deps.read()
    if (raw !== null) {
      try {
        next = usageSnapshotFrom(JSON.parse(raw) as TrackerReport)
      } catch (err) {
        serverLog(`[usage] unreadable report: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (this.stopped) return
    if (next && JSON.stringify(next) !== JSON.stringify(this.snapshot)) {
      this.snapshot = next
      this.onChange(next)
    }
    const delay = nextPollDelay(next, this.deps.now())
    this.cancel = this.deps.schedule(() => void this.poll(), delay)
  }
}
