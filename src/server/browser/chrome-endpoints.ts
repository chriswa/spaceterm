import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { connectCdp, type CdpConnection } from './cdp'

/**
 * Where the CDP connections for the two browser profiles come from.
 *
 * Both read the port Chrome writes to `DevToolsActivePort` in its data
 * directory: the first line is the port, the second the browser endpoint's
 * path.
 */

const execFileAsync = promisify(execFile)

export const CHROME_BINARY = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
export const DEFAULT_CHROME_DATA_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome')

/** A browser that cannot be reached, with what the user can do about it. Shown on the card as is. */
export class BrowserUnavailableError extends Error {}

const LIVE_CHROME_HELP =
  "Spaceterm can't reach your Chrome. In Chrome, open chrome://inspect/#remote-debugging and turn on remote debugging, then click Reload on this card."

export function readDevToolsEndpoint(dataDir: string): string | null {
  let text: string
  try {
    text = fs.readFileSync(path.join(dataDir, 'DevToolsActivePort'), 'utf8')
  } catch {
    return null
  }
  const [port, endpointPath] = text.trim().split('\n')
  if (!/^\d+$/.test(port ?? '') || !endpointPath?.startsWith('/')) return null
  return `ws://127.0.0.1:${port}${endpointPath}`
}

/**
 * The Chrome the user already runs, under its default profile. Connecting
 * makes Chrome ask the user to allow it, once per connection, so the handshake
 * may wait on them; callers keep one connection open rather than reconnecting.
 *
 * The port comes from `DevToolsActivePort` when the profile can be read. It
 * often cannot: endpoint protection (and macOS's app-data protection) refuse
 * other processes any read inside Chrome's profile, which is what keeps its
 * cookies safe. Then the port is found the other way, as the one the running
 * Chrome is listening on, and the browser endpoint is addressed without its id,
 * which Chrome accepts.
 */
export async function connectLiveChrome(
  dataDir = DEFAULT_CHROME_DATA_DIR,
  findPorts: () => Promise<number[]> = listeningChromePorts
): Promise<CdpConnection> {
  const endpoints = [readDevToolsEndpoint(dataDir) ?? (await findPorts()).map((port) => `ws://127.0.0.1:${port}/devtools/browser`)].flat()
  if (endpoints.length === 0) throw new BrowserUnavailableError(LIVE_CHROME_HELP)
  let lastError: unknown
  for (const endpoint of endpoints) {
    try {
      return await connectCdp(endpoint, 120_000)
    } catch (err) {
      // A port file left behind by a Chrome that has since quit, a port that is not DevTools, or a refusal at Chrome's dialog.
      lastError = err
    }
  }
  throw new BrowserUnavailableError(`${LIVE_CHROME_HELP} (${lastError instanceof Error ? lastError.message : String(lastError)})`)
}

/**
 * The loopback ports the user's own Chrome is listening on: its main process,
 * not Spaceterm's headless one (which names its own `--user-data-dir`).
 * Remote debugging is the only thing Chrome listens for, so with it off this
 * is empty.
 */
export async function listeningChromePorts(): Promise<number[]> {
  const run = async (file: string, args: string[]): Promise<string> => {
    try {
      return (await execFileAsync(file, args)).stdout
    } catch {
      return ''
    }
  }
  const ports: number[] = []
  for (const pid of (await run('pgrep', ['-x', 'Google Chrome'])).split('\n').filter(Boolean)) {
    const command = await run('ps', ['-o', 'command=', '-p', pid])
    if (command.includes('--user-data-dir') || command.includes('--headless')) continue
    const listing = await run('lsof', ['-nP', '-a', '-p', pid, '-iTCP', '-sTCP:LISTEN', '-Fn'])
    for (const line of listing.split('\n')) {
      const match = /^n127\.0\.0\.1:(\d+)$/.exec(line)
      if (match) ports.push(Number(match[1]))
    }
  }
  return ports
}

/**
 * A headless Chrome of Spaceterm's own, on a profile kept in `profileDir`.
 *
 * Started on first use and closed with the server. One left running by a
 * server that died is reused rather than fought: a second Chrome on the same
 * profile would hand its arguments to the first and exit.
 */
export class IsolatedChrome {
  private connecting: Promise<CdpConnection> | null = null
  private connection: CdpConnection | null = null

  constructor(
    private readonly profileDir: string,
    private readonly log: (line: string) => void,
    private readonly binary = CHROME_BINARY
  ) {}

  connect(): Promise<CdpConnection> {
    if (!this.connecting) {
      this.connecting = this.open().then(
        (conn) => {
          this.connection = conn
          conn.onClose(() => {
            this.connection = null
            this.connecting = null
          })
          return conn
        },
        (err) => {
          this.connecting = null
          throw err
        }
      )
    }
    return this.connecting
  }

  /** Close the browser, so it does not outlive the server. */
  async shutdown(): Promise<void> {
    const conn = this.connection
    if (!conn) return
    await conn.send('Browser.close').catch(() => undefined)
  }

  private async open(): Promise<CdpConnection> {
    const existing = readDevToolsEndpoint(this.profileDir)
    if (existing) {
      try {
        return await connectCdp(existing, 3_000)
      } catch {
        // Left by a Chrome that is gone; start a fresh one below.
      }
    }
    if (!fs.existsSync(this.binary)) {
      throw new BrowserUnavailableError(`The Spaceterm browser needs Google Chrome, which isn't at ${this.binary}.`)
    }
    fs.mkdirSync(this.profileDir, { recursive: true })
    fs.rmSync(path.join(this.profileDir, 'DevToolsActivePort'), { force: true })
    const child = spawn(this.binary, [
      '--headless=new',
      `--user-data-dir=${this.profileDir}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank'
    ], { stdio: 'ignore', detached: true })
    child.unref()
    this.log(`[browser] started the Spaceterm browser (pid ${child.pid}) on ${this.profileDir}`)

    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const endpoint = readDevToolsEndpoint(this.profileDir)
      if (endpoint) return connectCdp(endpoint, 5_000)
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new BrowserUnavailableError('The Spaceterm browser did not start within 15 s.')
  }
}
