import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'

/**
 * Keep the mobile web app's build (`out/mobile`) current without anyone
 * remembering to run `npm run mobile:build`.
 *
 * At server startup, and whenever a source the bundle is built from changes
 * (`MobileBuildKeeper`): if any source is newer than the build, rebuild — in a
 * child process, so nothing waits on it. The build goes to a staging directory
 * and is swapped in when complete, so the gateway never serves a half-written
 * one; until then it serves the previous build. A phone then sees its page is
 * behind (src/mobile/update-check.ts) and offers a reload.
 */

/** What the mobile bundle is built from, relative to the repo root. */
const SOURCES = ['src/mobile', 'src/client/renderer/src', 'src/shared', 'package-lock.json']

export interface MobileBuildDeps {
  /** Newest modification time among build inputs, in ms; 0 when none. */
  newestSource(): number
  /** Modification time of the built page, or null when there is no build. */
  builtAt(): number | null
  /** Run the build into `outDir`; resolves to whether it succeeded, with its output. */
  build(outDir: string): Promise<{ ok: boolean; output: string }>
  /** Replace `target` with `staged`. */
  swap(staged: string, target: string): void
  log(message: string): void
}

export function needsRebuild(newestSource: number, builtAt: number | null): boolean {
  return builtAt === null || newestSource > builtAt
}

/**
 * Never a source: dependencies, and build output — Xcode builds the iPhone
 * app into `src/mobile/ios/build`, and every install would otherwise look
 * like an edit.
 */
const IGNORED_NAMES = new Set(['node_modules', 'build'])

/** Whether a changed path, relative to a watched source, could change the bundle. */
export function isSourcePath(relative: string): boolean {
  return !relative.split(/[\\/]/).some((part) => IGNORED_NAMES.has(part) || part.startsWith('.'))
}

function newestMtime(entry: string): number {
  let stat: fs.Stats
  try {
    stat = fs.statSync(entry)
  } catch {
    return 0
  }
  if (!stat.isDirectory()) return /\.test\.tsx?$/.test(entry) ? 0 : stat.mtimeMs
  let newest = 0
  for (const name of fs.readdirSync(entry)) {
    if (IGNORED_NAMES.has(name) || name.startsWith('.')) continue
    newest = Math.max(newest, newestMtime(path.join(entry, name)))
  }
  return newest
}

export function realMobileBuildDeps(repoRoot: string, outDir: string, log: (m: string) => void): MobileBuildDeps {
  return {
    newestSource: () => Math.max(...SOURCES.map((s) => newestMtime(path.join(repoRoot, s)))),
    builtAt() {
      try {
        return fs.statSync(path.join(outDir, 'index.html')).mtimeMs
      } catch {
        return null
      }
    },
    build(stagingDir) {
      return new Promise((resolve) => {
        const vite = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js')
        const child = spawn(process.execPath, [
          vite, 'build', '--config', path.join(repoRoot, 'src', 'mobile', 'vite.config.ts'),
          '--outDir', stagingDir, '--emptyOutDir', '--logLevel', 'warn'
        ], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] })
        let output = ''
        child.stdout.on('data', (d) => { output += d })
        child.stderr.on('data', (d) => { output += d })
        child.on('error', (err) => resolve({ ok: false, output: err.message }))
        child.on('exit', (code) => resolve({ ok: code === 0, output }))
      })
    },
    swap(staged, target) {
      const old = `${target}.old`
      fs.rmSync(old, { recursive: true, force: true })
      if (fs.existsSync(target)) fs.renameSync(target, old)
      fs.renameSync(staged, target)
      fs.rmSync(old, { recursive: true, force: true })
    },
    log
  }
}

/**
 * Rebuild if stale. Returns the build's promise for tests and logging; the
 * server does not await it.
 */
export async function refreshMobileBuild(outDir: string, deps: MobileBuildDeps): Promise<'current' | 'rebuilt' | 'failed'> {
  if (!needsRebuild(deps.newestSource(), deps.builtAt())) return 'current'
  const started = Date.now()
  deps.log('[mobile-build] Sources changed since the last build; rebuilding in the background')
  const staging = `${outDir}.next`
  const { ok, output } = await deps.build(staging)
  if (!ok) {
    deps.log(`[mobile-build] Build failed; still serving the previous one:\n${output.trim()}`)
    return 'failed'
  }
  try {
    deps.swap(staging, outDir)
  } catch (err) {
    deps.log(`[mobile-build] Built, but could not swap it in: ${err instanceof Error ? err.message : String(err)}`)
    return 'failed'
  }
  deps.log(`[mobile-build] Rebuilt in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  return 'rebuilt'
}

/** Edits come in bursts — a save, an agent's run of edits: build once they stop. */
export const QUIET_MS = 2_000

export interface MobileBuildKeeperDeps {
  refresh(): Promise<'current' | 'rebuilt' | 'failed'>
  schedule(fn: () => void, ms: number): () => void
}

/**
 * Rebuilds as sources change: once they have been quiet for `QUIET_MS`, never
 * two builds at once, and once more if they changed while it ran.
 */
export class MobileBuildKeeper {
  private cancelWait: (() => void) | null = null
  private building = false
  private changedWhileBuilding = false

  constructor(
    private readonly deps: MobileBuildKeeperDeps,
    /** A new build is being served. */
    private readonly onRebuilt: () => void
  ) {}

  /** Bring the build up to date now — at startup. */
  refreshNow(): Promise<void> {
    return this.run()
  }

  /** A source changed. */
  changed(): void {
    if (this.building) {
      this.changedWhileBuilding = true
      return
    }
    this.cancelWait?.()
    this.cancelWait = this.deps.schedule(() => {
      this.cancelWait = null
      void this.run()
    }, QUIET_MS)
  }

  private async run(): Promise<void> {
    this.building = true
    this.changedWhileBuilding = false
    try {
      if ((await this.deps.refresh()) === 'rebuilt') this.onRebuilt()
    } finally {
      this.building = false
      if (this.changedWhileBuilding) this.changed()
    }
  }
}

/** Watch every source of the bundle; returns a function that stops watching. */
export function watchMobileSources(repoRoot: string, onChange: () => void, log: (m: string) => void): () => void {
  const watchers: fs.FSWatcher[] = []
  for (const source of SOURCES) {
    const full = path.join(repoRoot, source)
    try {
      const recursive = fs.statSync(full).isDirectory()
      watchers.push(fs.watch(full, { recursive }, (_event, name) => {
        if (!name || isSourcePath(name.toString())) onChange()
      }))
    } catch (err) {
      log(`[mobile-build] Cannot watch ${source}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return () => { for (const w of watchers) w.close() }
}
