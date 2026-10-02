import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'

/**
 * Keep the mobile web app's build (`out/mobile`) current without anyone
 * remembering to run `npm run mobile:build`.
 *
 * On server startup: if any source the bundle is built from is newer than the
 * build, rebuild — in a child process, so startup never waits on it. The build
 * goes to a staging directory and is swapped in when complete, so the gateway
 * never serves a half-written one; until then it serves the previous build.
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
    if (name === 'node_modules' || name.startsWith('.')) continue
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
