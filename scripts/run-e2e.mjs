#!/usr/bin/env node
/**
 * Run the Electron end-to-end suite, supplying a display if the platform needs
 * one.
 *
 * macOS has a window server, so vitest runs directly. Linux CI and every cloud
 * agent container do not, so the run is wrapped in `xvfb-run -a` — the `-a`
 * picks a free display number rather than colliding with whatever else is
 * running.
 *
 * Kept out of the npm script because `xvfb-run vitest ...` in package.json
 * would break every macOS developer, and a package.json script cannot branch.
 */
import { spawnSync, execFileSync } from 'child_process'

const vitestArgs = ['vitest', 'run', '--project', 'e2e', ...process.argv.slice(2)]

function have(binary) {
  try {
    execFileSync('which', [binary], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

let command = 'npx'
let args = vitestArgs

if (process.platform === 'linux' && !process.env.DISPLAY) {
  if (!have('xvfb-run')) {
    console.error('[e2e] No DISPLAY and no xvfb-run. Install xvfb, or run under an X session.')
    console.error('[e2e]   Debian/Ubuntu: apt-get install -y xvfb')
    process.exit(1)
  }
  command = 'xvfb-run'
  args = ['-a', 'npx', ...vitestArgs]
}

const result = spawnSync(command, args, { stdio: 'inherit' })
process.exit(result.status ?? 1)
