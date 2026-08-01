#!/usr/bin/env node
/**
 * Make sure Electron's binary is on disk, downloading it if not.
 *
 * `npm install --ignore-scripts` — which CI and every cloud agent session uses
 * to skip the `electron-rebuild` postinstall — also skips the *electron*
 * package's own postinstall, which is the thing that fetches the ~100 MB
 * runtime. The two are unrelated: electron-rebuild compiles native modules
 * against Electron's headers and genuinely needs a toolchain, while this is a
 * zip download. Skipping both together is what made "the GUI cannot be launched
 * here" true, and it was never actually necessary.
 *
 * Idempotent and cheap to re-run: the download is cached in
 * `~/.cache/electron`, so a warm container re-extracts in about three seconds.
 *
 * Never fatal. A machine with no network still typechecks, lints and runs every
 * unit test; only the Electron end-to-end suite needs this, and it says so when
 * it skips.
 */
import { existsSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronDir = join(repoRoot, 'node_modules', 'electron')
const pathFile = join(electronDir, 'path.txt')
const installer = join(electronDir, 'install.js')

/** The binary electron's own `index.js` would resolve, or null. */
function installedBinary() {
  if (!existsSync(pathFile)) return null
  const relative = readFileSync(pathFile, 'utf-8').trim()
  if (!relative) return null
  const binary = join(electronDir, 'dist', relative)
  return existsSync(binary) ? binary : null
}

const already = installedBinary()
if (already) {
  console.log(`[electron] binary present: ${already}`)
  process.exit(0)
}

if (!existsSync(installer)) {
  console.log('[electron] package not installed; nothing to download')
  process.exit(0)
}

console.log('[electron] binary missing — downloading (cached in ~/.cache/electron)')
try {
  execFileSync(process.execPath, [installer], { cwd: electronDir, stdio: 'inherit' })
} catch (err) {
  // Offline, firewalled, or out of disk. Everything except the Electron E2E
  // suite still works, so say what is lost and let the caller continue.
  console.warn(`[electron] download failed: ${err.message}`)
  console.warn('[electron] unit tests are unaffected; `npm run test:e2e` will skip')
  process.exit(0)
}

const now = installedBinary()
console.log(now ? `[electron] ready: ${now}` : '[electron] download reported success but no binary appeared')
