import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import { randomBytes, timingSafeEqual } from 'crypto'
import { WebSocketServer, WebSocket } from 'ws'
import type { ClientLink } from './client-link'

/**
 * The mobile web app's way in: one HTTP server that serves the built app and
 * upgrades `/ws` into an ordinary client connection.
 *
 * **Loopback only.** It never listens on a network interface. Reaching it from
 * a phone is `tailscale serve`'s job, which puts it behind the tailnet's own
 * access control and a real certificate — Safari will not give a page the
 * microphone without HTTPS.
 *
 * **A token on the socket, because loopback is not enough.** A WebSocket is
 * exempt from CORS, so any web page open in any browser on this Mac could
 * otherwise connect to 127.0.0.1 and drive a terminal. The page itself is
 * served without one (it is just the app), and the token travels in the URL
 * fragment the first time, which a browser never sends anywhere.
 */

export const DEFAULT_WEB_PORT = 7391

/** Past this much unsent output, the link is dropped; the client reconnects and resyncs. */
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024
/** A phone on LTE vanishes without a FIN. Pinged this often; missing a pong ends it. */
const HEARTBEAT_MS = 30_000

export interface WebGatewayOptions {
  port: number
  staticRoot: string
  token: string
  /** Admit a connection as a client — the same function the Unix socket uses. */
  accept(link: ClientLink): { feed(data: string): void; close(): void }
  log(message: string): void
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm'
}

/** Read the gateway token, minting one on first use. Owner-only, like the sockets beside it. */
export function loadOrCreateWebToken(dir: string): string {
  const file = path.join(dir, 'web-token')
  try {
    const existing = fs.readFileSync(file, 'utf8').trim()
    if (existing.length >= 32) return existing
  } catch {
    // First run.
  }
  const token = randomBytes(24).toString('base64url')
  fs.writeFileSync(file, token + '\n', { mode: 0o600 })
  return token
}

function tokenMatches(given: string | null, expected: string): boolean {
  if (!given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * A request path, resolved inside `root` — or null for anything that would
 * escape it. Unknown paths fall back to the app's index so a reload on any
 * route still loads the app.
 */
export function resolveStatic(root: string, urlPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0])
  } catch {
    return null
  }
  const target = path.resolve(root, '.' + path.posix.normalize('/' + decoded))
  if (target !== root && !target.startsWith(root + path.sep)) return null
  if (fs.existsSync(target) && fs.statSync(target).isFile()) return target
  return path.join(root, 'index.html')
}

function serveStatic(root: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end()
    return
  }
  const file = resolveStatic(root, req.url ?? '/')
  if (!file || !fs.existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end(
      'The mobile app has not been built. Run: npm run mobile:build'
    )
    return
  }
  const ext = path.extname(file)
  // Only what the build put in assets/ is named by its content, and so can
  // never change under its name. Everything else — the page, build.json (how
  // the page learns a newer build exists) — must be asked for afresh.
  const hashed = file.startsWith(path.join(root, 'assets') + path.sep)
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer'
  })
  if (req.method === 'HEAD') res.end()
  else fs.createReadStream(file).pipe(res)
}

export function startWebGateway(options: WebGatewayOptions): http.Server {
  const root = path.resolve(options.staticRoot)
  const server = http.createServer((req, res) => serveStatic(root, req, res))
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 256 } })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://gateway')
    if (url.pathname !== '/ws' || !tokenMatches(url.searchParams.get('token'), options.token)) {
      options.log(`[web-gateway] Refused a socket upgrade for ${url.pathname} (${url.pathname === '/ws' ? 'bad token' : 'wrong path'})`)
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => connect(ws))
  })

  function connect(ws: WebSocket): void {
    let alive = true
    const connection = options.accept({
      write(text) {
        if (ws.readyState !== WebSocket.OPEN) return
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
          options.log('[web-gateway] Client fell too far behind; dropping it so it reconnects and resyncs')
          ws.terminate()
          return
        }
        ws.send(text)
      }
    })
    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate()
        return
      }
      alive = false
      ws.ping()
    }, HEARTBEAT_MS)
    ws.on('pong', () => { alive = true })
    ws.on('message', (data) => connection.feed(data.toString()))
    ws.on('close', () => {
      clearInterval(heartbeat)
      connection.close()
    })
    ws.on('error', () => undefined)
  }

  server.on('error', (err) => options.log(`[web-gateway] ${err.message} — the mobile app is unavailable`))
  server.listen(options.port, '127.0.0.1', () => {
    options.log(`[web-gateway] Serving the mobile app on http://127.0.0.1:${options.port}`)
  })
  return server
}
