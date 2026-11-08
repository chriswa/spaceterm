/**
 * Apple's push service: reaches a phone with its app suspended or not running,
 * which nothing over the Spaceterm socket can. Sent directly, over HTTP/2,
 * signed with the key the user saved in `~/.spaceterm/`
 * (src/mobile/README.md, "Told when an agent is blocked").
 *
 * Never throws and never rejects: a push that cannot be sent is reported as
 * `false`, for the caller to fall back on the socket.
 */

import { sign } from 'crypto'
import * as fs from 'fs'
import * as http2 from 'http2'
import * as path from 'path'
import type { NodeId } from '../shared/ids'

/** Sandbox because every install of the app is signed for development (install.sh). */
const APNS_ORIGIN = 'https://api.sandbox.push.apple.com'
/** Apple accepts a token for an hour and refuses new ones more often than every 20 minutes. */
const JWT_LIFETIME_MS = 50 * 60_000
const REQUEST_TIMEOUT_MS = 10_000
/** A push is at most 4 KB of JSON, and these are UTF-16 units of up to 3 bytes each. */
const TITLE_CHARS = 100
const BODY_CHARS = 800

export interface ApnsCredentials {
  keyId: string
  teamId: string
  /** The app's bundle id. */
  topic: string
  /** The `.p8` file's contents. */
  key: string
}

export interface ApnsResponse {
  status: number
  reason?: string
}

export interface ApnsDeps {
  /** Null until the key is saved; asked again each time, so saving one needs no restart. */
  credentials(): ApnsCredentials | null
  loadDevices(): Record<string, string>
  saveDevices(devices: Record<string, string>): void
  post(path: string, headers: Record<string, string>, body: string): Promise<ApnsResponse>
  log(message: string): void
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

function capped(text: string, chars: number): string {
  return text.length > chars ? `${text.slice(0, chars - 1)}…` : text
}

export class ApnsSender {
  /** Device id → token. A token is a phone's, so it is under one device at most. */
  private readonly devices: Record<string, string>
  private jwt: { token: string; keyId: string; mintedAt: number } | undefined

  constructor(private readonly deps: ApnsDeps) {
    this.devices = deps.loadDevices()
  }

  register(deviceId: string, token: string): void {
    if (!/^[0-9a-f]{32,400}$/i.test(token)) {
      this.deps.log(`[apns] Ignored a malformed token from ${deviceId}`)
      return
    }
    if (this.devices[deviceId] === token) return
    for (const [other, existing] of Object.entries(this.devices)) {
      if (existing === token) delete this.devices[other]
    }
    this.devices[deviceId] = token
    this.deps.saveDevices(this.devices)
    this.deps.log(`[apns] Registered ${deviceId}`)
  }

  /** Whether any phone was reached. */
  alert(alert: { nodeId: NodeId; title: string; body: string }, now = Date.now()): Promise<boolean> {
    return this.deliver({
      'apns-push-type': 'alert',
      'apns-priority': '10',
      // A second prompt from the same agent replaces the first.
      'apns-collapse-id': alert.nodeId,
    }, {
      aps: { alert: { title: capped(alert.title, TITLE_CHARS), body: capped(alert.body, BODY_CHARS) }, sound: 'default' },
      nodeId: alert.nodeId,
    }, now)
  }

  /** A quiet push asking the app to take that agent's notification away. iOS may delay or drop it. */
  clear(nodeId: NodeId, now = Date.now()): Promise<boolean> {
    return this.deliver(
      { 'apns-push-type': 'background', 'apns-priority': '5' },
      { aps: { 'content-available': 1 }, clearNodeId: nodeId },
      now,
    )
  }

  private async deliver(headers: Record<string, string>, payload: object, now: number): Promise<boolean> {
    const devices = Object.entries(this.devices)
    if (devices.length === 0) return false
    try {
      const credentials = this.deps.credentials()
      if (!credentials) return false
      const authorized = {
        ...headers,
        authorization: `bearer ${this.providerToken(credentials, now)}`,
        'apns-topic': credentials.topic,
      }
      const body = JSON.stringify(payload)
      const sent = await Promise.all(devices.map(([deviceId, token]) => this.send(deviceId, token, authorized, body)))
      return sent.some(Boolean)
    } catch (err) {
      this.deps.log(`[apns] Could not send: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  private async send(deviceId: string, token: string, headers: Record<string, string>, body: string): Promise<boolean> {
    try {
      const { status, reason } = await this.deps.post(`/3/device/${token}`, headers, body)
      if (status === 200) return true
      this.deps.log(`[apns] ${deviceId}: ${status} ${reason ?? ''}`)
      if (status === 410 || reason === 'BadDeviceToken') {
        delete this.devices[deviceId]
        this.deps.saveDevices(this.devices)
      }
      if (reason === 'ExpiredProviderToken' || reason === 'InvalidProviderToken') this.jwt = undefined
    } catch (err) {
      this.deps.log(`[apns] ${deviceId}: ${err instanceof Error ? err.message : String(err)}`)
    }
    return false
  }

  private providerToken(credentials: ApnsCredentials, now: number): string {
    if (this.jwt && this.jwt.keyId === credentials.keyId && now - this.jwt.mintedAt < JWT_LIFETIME_MS) return this.jwt.token
    const header = base64url(JSON.stringify({ alg: 'ES256', kid: credentials.keyId }))
    const claims = base64url(JSON.stringify({ iss: credentials.teamId, iat: Math.floor(now / 1000) }))
    const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key: credentials.key, dsaEncoding: 'ieee-p1363' })
    const token = `${header}.${claims}.${base64url(signature)}`
    this.jwt = { token, keyId: credentials.keyId, mintedAt: now }
    return token
  }
}

/** POSTs over one HTTP/2 connection, kept open as Apple asks and reopened when it drops. */
export function http2Poster(origin: string): ApnsDeps['post'] {
  let session: http2.ClientHttp2Session | undefined
  const connect = (): http2.ClientHttp2Session => {
    if (session && !session.closed && !session.destroyed) return session
    const opened = http2.connect(origin)
    opened.unref()
    opened.on('error', () => opened.destroy())
    opened.on('close', () => { if (session === opened) session = undefined })
    session = opened
    return opened
  }
  return (requestPath, headers, body) => new Promise((resolve, reject) => {
    const request = connect().request({ ':method': 'POST', ':path': requestPath, ...headers })
    let status = 0
    let text = ''
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.close(http2.constants.NGHTTP2_CANCEL)
      reject(new Error('timed out'))
    })
    request.setEncoding('utf8')
    request.on('response', (responseHeaders) => { status = Number(responseHeaders[':status']) })
    request.on('data', (chunk: string) => { text += chunk })
    request.on('error', reject)
    request.on('end', () => {
      let reason: string | undefined
      try { reason = (JSON.parse(text) as { reason?: string }).reason } catch { /* A 200 has no body. */ }
      resolve({ status, ...(reason ? { reason } : {}) })
    })
    request.end(body)
  })
}

/** `name = value` from an xcconfig, or undefined. */
export function xcconfigValue(text: string, name: string): string | undefined {
  for (const line of text.split('\n')) {
    const [key, ...value] = line.split('=')
    if (key.trim() === name && value.length > 0) return value.join('=').trim() || undefined
  }
  return undefined
}

export function realApnsDeps(dir: string, repoRoot: string, log: (message: string) => void): ApnsDeps {
  const devicesFile = path.join(dir, 'apns-devices.json')
  return {
    credentials() {
      const keyFile = fs.readdirSync(dir).filter((name) => /^AuthKey_\w+\.p8$/.test(name)).sort().at(-1)
      if (!keyFile) return null
      const config = fs.readFileSync(path.join(repoRoot, 'src/mobile/ios/Local.xcconfig'), 'utf8')
      const teamId = xcconfigValue(config, 'DEVELOPMENT_TEAM')
      const topic = xcconfigValue(config, 'PRODUCT_BUNDLE_IDENTIFIER')
      if (!teamId || !topic) {
        log('[apns] Local.xcconfig has no DEVELOPMENT_TEAM or PRODUCT_BUNDLE_IDENTIFIER')
        return null
      }
      return { keyId: keyFile.slice('AuthKey_'.length, -'.p8'.length), teamId, topic, key: fs.readFileSync(path.join(dir, keyFile), 'utf8') }
    },
    loadDevices() {
      try {
        return JSON.parse(fs.readFileSync(devicesFile, 'utf8')) as Record<string, string>
      } catch {
        return {}
      }
    },
    saveDevices(devices) {
      fs.writeFileSync(devicesFile, JSON.stringify(devices, null, 2) + '\n', { mode: 0o600 })
    },
    post: http2Poster(APNS_ORIGIN),
    log,
  }
}
