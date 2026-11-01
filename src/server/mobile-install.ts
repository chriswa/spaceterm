import { spawn } from 'child_process'
import { randomBytes } from 'crypto'
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
 *
 * **Over the air, when the phone is away.** Xcode reaches a phone only on the
 * Mac's own network or a cable — never over Tailscale — and the script says so
 * with exit status 2. The installer then has the script build the app as a
 * download instead, served by the web gateway under a fresh secret
 * (`downloadFile`), and answers with the `itms-services:` link that has iOS
 * fetch and install it. The phone opens the link; iOS asks before installing.
 */

export type InstallOutcome =
  | { ok: true }
  | { ok: false; message: string }
  /** Not installed yet: opening `installUrl` on the phone installs it. */
  | { ok: false; message: string; installUrl: string }

/** The script's status for a paired phone it cannot reach (install.sh). */
const PHONE_UNREACHABLE = 2

/** What the download is made of, as install.sh --over-the-air leaves it. */
const DOWNLOAD_FILES = ['manifest.plist', 'SpacetermMobile.ipa', 'icon.png'] as const

export interface MobileInstallDeps {
  /** Run the install script with these arguments; resolves with its exit status and combined output. */
  run(args: string[]): Promise<{ code: number | null; output: string }>
  /** Where install.sh --over-the-air leaves the download. */
  downloadDir: string
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
  const iosDir = path.join(repoRoot, 'src', 'mobile', 'ios')
  return {
    downloadDir: path.join(iosDir, 'build', 'over-the-air'),
    run: (args) => new Promise((resolve) => {
      const child = spawn(path.join(iosDir, 'install.sh'), args, {
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
  /**
   * The path segment the current download is served under, or null when there
   * is none. The app carries this Mac's pairing tokens, so it is not served
   * to anyone who has not been handed the link; each build has a new secret.
   */
  private downloadSecret: string | null = null

  constructor(private readonly deps: MobileInstallDeps) {}

  /** Install, or join the install already under way: one build at a time. */
  install(): Promise<InstallOutcome> {
    this.running ??= this.runOnce().finally(() => { this.running = null })
    return this.running
  }

  /**
   * The file a request for `urlPath` is asking for, if it is part of the
   * current download (`/install/<secret>/<file>`) — for the web gateway.
   */
  downloadFile(urlPath: string): string | null {
    const match = /^\/install\/([^/]+)\/([^/?]+)$/.exec(urlPath.split('?')[0])
    if (!match || !this.downloadSecret || match[1] !== this.downloadSecret) return null
    const name = DOWNLOAD_FILES.find((f) => f === match[2])
    return name ? path.join(this.deps.downloadDir, name) : null
  }

  private async runOnce(): Promise<InstallOutcome> {
    const started = Date.now()
    serverLog('[mobile-install] Building and installing the iPhone app, as the phone asked')
    const { code, output } = await this.deps.run([])
    const seconds = ((Date.now() - started) / 1000).toFixed(0)
    if (code === 0) {
      serverLog(`[mobile-install] Done in ${seconds}s: ${output.trim().split('\n').at(-1) ?? ''}`)
      return { ok: true }
    }
    if (code === PHONE_UNREACHABLE) {
      serverLog(`[mobile-install] ${output.trim()} Building a download for it instead.`)
      return this.buildDownload()
    }
    serverLog(`[mobile-install] Failed after ${seconds}s:\n${output.trim()}`)
    return { ok: false, message: failureMessage(output) }
  }

  private async buildDownload(): Promise<InstallOutcome> {
    const started = Date.now()
    // The old download stops being served the moment its files are replaced.
    this.downloadSecret = null
    const secret = randomBytes(24).toString('base64url')
    const { code, output } = await this.deps.run(['--over-the-air', secret])
    const seconds = ((Date.now() - started) / 1000).toFixed(0)
    const manifestUrl = output.trim().split('\n').at(-1) ?? ''
    if (code !== 0 || !manifestUrl.startsWith('https://')) {
      serverLog(`[mobile-install] The download failed after ${seconds}s:\n${output.trim()}`)
      return { ok: false, message: failureMessage(output) }
    }
    this.downloadSecret = secret
    serverLog(`[mobile-install] Built a download in ${seconds}s; the phone installs it from the link`)
    return {
      ok: false,
      message: 'The phone is away from the Mac\'s network, so it installs from a download: tap Install when it asks.',
      installUrl: `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`,
    }
  }
}
