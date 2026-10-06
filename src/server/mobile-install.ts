import { spawn } from 'child_process'
import * as path from 'path'
import { serverLog } from './server-log'

/**
 * Build and install the iPhone app on the paired phone, when the phone asks —
 * the toolbar sheet's install button (InstallAppButton, toolbar/buttons.tsx). The same script as
 * `npm run mobile:ios`, run on this Mac, which is the only side that can.
 *
 * Success ends with the new app launched over the old one, so the phone that
 * asked usually never hears the answer; a failure it does hear, with the
 * script's own last words.
 */

export type InstallOutcome = { ok: true } | { ok: false; message: string }

export interface MobileInstallDeps {
  /** Run the install script; resolves with its exit status and combined output. */
  run(): Promise<{ code: number | null; output: string }>
}

/**
 * The script's closing lines, which is where it says what went wrong — less
 * the rules Xcode's tools draw between parts of an error, which are most of
 * its last lines and say nothing.
 */
export function failureMessage(output: string): string {
  const lines = output.split('\n').map((l) => l.trim()).filter((l) => /\w/.test(l))
  return lines.slice(-3).join('\n') || 'The install script failed without saying why.'
}

export function realMobileInstallDeps(repoRoot: string): MobileInstallDeps {
  return {
    run: () => new Promise((resolve) => {
      const child = spawn(path.join(repoRoot, 'src', 'mobile', 'ios', 'install.sh'), [], {
        cwd: repoRoot,
        // The script calls node and npx; this server's own node is the one to find.
        env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      child.stdout.on('data', (d) => { output += d })
      child.stderr.on('data', (d) => { output += d })
      child.on('error', (err) => resolve({ code: null, output: err.message }))
      child.on('exit', (code) => resolve({ code, output }))
    }),
  }
}

export class MobileAppInstaller {
  private running: Promise<InstallOutcome> | null = null

  constructor(private readonly deps: MobileInstallDeps) {}

  /** Install, or join the install already under way: one build at a time. */
  install(): Promise<InstallOutcome> {
    this.running ??= this.runOnce().finally(() => { this.running = null })
    return this.running
  }

  private async runOnce(): Promise<InstallOutcome> {
    const started = Date.now()
    serverLog('[mobile-install] Building and installing the iPhone app, as the phone asked')
    const { code, output } = await this.deps.run()
    const seconds = ((Date.now() - started) / 1000).toFixed(0)
    if (code === 0) {
      serverLog(`[mobile-install] Done in ${seconds}s: ${output.trim().split('\n').at(-1) ?? ''}`)
      return { ok: true }
    }
    serverLog(`[mobile-install] Failed after ${seconds}s:\n${output.trim()}`)
    return { ok: false, message: failureMessage(output) }
  }
}
