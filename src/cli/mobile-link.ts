/**
 * Print the link that pairs a phone with this Mac's Spaceterm.
 *
 *   npm run mobile:link
 *   npm run mobile:link -- --url    # just the URL, for scripts (src/mobile/ios/install.sh)
 *
 * The token rides in the URL fragment, which a browser never sends anywhere;
 * the app stores it on first load. Treat the link like a password — it opens a
 * shell on this machine to anyone who has it and can reach your tailnet.
 */
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { SOCKET_DIR } from '../shared/protocol'
import { DEFAULT_WEB_PORT, loadOrCreateWebToken } from '../server/web-gateway'

const TAILSCALE_CANDIDATES = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']

function tailscale(args: string[]): string | null {
  for (const bin of TAILSCALE_CANDIDATES) {
    if (bin.startsWith('/') && !existsSync(bin)) continue
    try {
      return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      // Not this one, or not logged in.
    }
  }
  return null
}

const urlOnly = process.argv.includes('--url')
const port = Number(process.env.SPACETERM_WEB_PORT ?? DEFAULT_WEB_PORT)
const token = loadOrCreateWebToken(SOCKET_DIR)

const status = tailscale(['status', '--json'])
const dnsName = status ? (JSON.parse(status) as { Self?: { DNSName?: string } }).Self?.DNSName?.replace(/\.$/, '') : undefined

if (!dnsName && urlOnly) {
  console.error('Tailscale is not installed or not logged in on this Mac; run `npm run mobile:link` for setup steps.')
  process.exit(1)
}
if (urlOnly) {
  console.log(`https://${dnsName}/#token=${token}`)
  process.exit(0)
}

if (!dnsName) {
  console.log(`Tailscale is not installed or not logged in on this Mac.

The phone reaches Spaceterm through your tailnet, which is also what gives it
HTTPS — Safari will not allow the microphone without it. To set it up:

  1. Install Tailscale on this Mac and on the phone, signed in to the same account.
  2. In the Tailscale admin console, under DNS, enable MagicDNS and HTTPS Certificates.
  3. Run this again.

For a quick look in a browser on this Mac:
  http://127.0.0.1:${port}/#token=${token}`)
  process.exit(1)
}

const serving = tailscale(['serve', 'status']) ?? ''
if (!serving.includes(`127.0.0.1:${port}`) && !serving.includes(`localhost:${port}`)) {
  console.log(`Expose the web gateway on your tailnet once (it survives restarts):

  tailscale serve --bg ${port}
`)
}

console.log(`Open this on your phone, then Share → Add to Home Screen:

  https://${dnsName}/#token=${token}
`)
