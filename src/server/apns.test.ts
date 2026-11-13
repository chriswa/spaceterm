import { generateKeyPairSync, verify } from 'crypto'
import * as http2 from 'http2'
import type { AddressInfo } from 'net'
import { describe, expect, it } from 'vitest'
import { asNodeId } from '../shared/ids'
import { ApnsSender, http2Poster, xcconfigValue, type ApnsDeps, type ApnsResponse } from './apns'

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const key = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const TOKEN = 'ab'.repeat(32)
const nodeId = asNodeId('11111111-1111-1111-1111-111111111111')
const alert = { nodeId, title: 'Fix the build', body: 'It asks a question' }

function make(overrides: Partial<ApnsDeps> & { respond?: () => ApnsResponse; devices?: Record<string, string> } = {}) {
  const posts: Array<{ path: string; headers: Record<string, string>; body: string }> = []
  const saved: Array<Record<string, string>> = []
  const logs: string[] = []
  const sender = new ApnsSender({
    credentials: () => ({ keyId: 'KEY1', teamId: 'TEAM1', topic: 'com.example.app', key }),
    loadDevices: () => ({ ...(overrides.devices ?? { phone: TOKEN }) }),
    saveDevices: (devices) => saved.push({ ...devices }),
    post: async (path, headers, body) => {
      posts.push({ path, headers, body })
      return overrides.respond?.() ?? { status: 200 }
    },
    log: (message) => logs.push(message),
    ...overrides,
  })
  return { sender, posts, saved, logs }
}

describe('ApnsSender', () => {
  it('sends an alert addressed to the phone, for the app', async () => {
    const { sender, posts } = make()
    expect(await sender.alert(alert)).toEqual({ sent: true })
    expect(posts[0].path).toBe(`/3/device/${TOKEN}`)
    expect(posts[0].headers).toMatchObject({ 'apns-topic': 'com.example.app', 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-collapse-id': nodeId })
    expect(JSON.parse(posts[0].body)).toEqual({ aps: { alert: { title: alert.title, body: alert.body }, sound: 'default' }, nodeId })
  })

  it('says which Mac it came from, under the title', async () => {
    const { sender, posts } = make()
    await sender.alert({ ...alert, source: 'Work' })
    expect(JSON.parse(posts[0].body).aps.alert).toEqual({ title: alert.title, subtitle: 'Work', body: alert.body })
  })

  it('signs with the key, as Apple requires', async () => {
    const { sender, posts } = make()
    await sender.alert(alert, 5_000_000)
    const [header, claims, signature] = posts[0].headers.authorization.replace('bearer ', '').split('.')
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KEY1' })
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({ iss: 'TEAM1', iat: 5000 })
    const signed = Buffer.from(`${header}.${claims}`)
    expect(verify('sha256', signed, { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))).toBe(true)
  })

  it('reuses its token, within the hour Apple allows', async () => {
    const { sender, posts } = make()
    await sender.alert(alert, 0)
    await sender.alert(alert, 30 * 60_000)
    await sender.alert(alert, 60 * 60_000)
    const tokens = posts.map(p => p.headers.authorization)
    expect(tokens[1]).toBe(tokens[0])
    expect(tokens[2]).not.toBe(tokens[0])
  })

  it('keeps a long prompt inside the 4 KB limit', async () => {
    const { sender, posts } = make()
    await sender.alert({ nodeId, title: '語'.repeat(500), body: '語'.repeat(5000) })
    expect(Buffer.byteLength(posts[0].body)).toBeLessThan(4096)
  })

  it('asks quietly for a notification to go', async () => {
    const { sender, posts } = make()
    await sender.clear(nodeId)
    expect(posts[0].headers).toMatchObject({ 'apns-push-type': 'background', 'apns-priority': '5' })
    expect(JSON.parse(posts[0].body)).toEqual({ aps: { 'content-available': 1 }, clearNodeId: nodeId })
  })

  it('reports nothing sent with no key saved, and says so in the log', async () => {
    const { sender, posts, logs } = make({ credentials: () => null })
    expect(await sender.alert(alert)).toMatchObject({ sent: false, why: expect.stringContaining('AuthKey') })
    expect(posts).toEqual([])
    expect(logs.at(-1)).toContain('AuthKey')
  })

  it('logs each notification sent', async () => {
    const { sender, logs } = make()
    await sender.alert(alert)
    expect(logs.at(-1)).toContain('Sent a notification')
  })

  it('marks a notification to show even on its own terminal', async () => {
    const { sender, posts } = make()
    await sender.alert({ ...alert, always: true })
    expect(JSON.parse(posts[0].body)).toMatchObject({ nodeId, always: true })
  })

  it('reports nothing sent with no phone registered', async () => {
    const { sender, posts } = make({ devices: {} })
    expect((await sender.alert(alert)).sent).toBe(false)
    expect(posts).toEqual([])
  })

  it('reports nothing sent when the network fails, and does not reject', async () => {
    const { sender } = make({ post: async () => { throw new Error('offline') } })
    expect((await sender.alert(alert)).sent).toBe(false)
  })

  it('reports nothing sent for a key it cannot read', async () => {
    const { sender } = make({ credentials: () => ({ keyId: 'K', teamId: 'T', topic: 'x', key: 'garbage' }) })
    expect((await sender.alert(alert)).sent).toBe(false)
  })

  it.each([
    [{ status: 410, reason: 'Unregistered' }],
    [{ status: 400, reason: 'BadDeviceToken' }],
  ])('forgets a phone Apple no longer knows: %j', async (response) => {
    const { sender, posts, saved } = make({ respond: () => response })
    expect((await sender.alert(alert)).sent).toBe(false)
    expect(saved.at(-1)).toEqual({})
    await sender.alert(alert)
    expect(posts).toHaveLength(1)
  })

  it('keeps a phone through other refusals', async () => {
    const { sender, saved } = make({ respond: () => ({ status: 429, reason: 'TooManyRequests' }) })
    await sender.alert(alert)
    expect(saved).toEqual([])
  })

  it('mints a new token after Apple rejects one', async () => {
    let refuse = true
    const { sender, posts } = make({ respond: () => (refuse ? { status: 403, reason: 'InvalidProviderToken' } : { status: 200 }) })
    await sender.alert(alert, 1_000)
    refuse = false
    await sender.alert(alert, 2_000)
    expect(posts[1].headers.authorization).not.toBe(posts[0].headers.authorization)
  })

  it('registers a phone once, and moves a token between device ids', () => {
    const { sender, saved } = make({ devices: {} })
    sender.register('a', TOKEN)
    sender.register('a', TOKEN)
    sender.register('b', TOKEN)
    expect(saved).toEqual([{ a: TOKEN }, { b: TOKEN }])
  })

  it('ignores a malformed token', () => {
    const { sender, saved } = make({ devices: {} })
    sender.register('a', '../../etc/passwd')
    expect(saved).toEqual([])
  })
})

describe('http2Poster', () => {
  it('posts and reads the reason, over one connection', async () => {
    const server = http2.createServer()
    const seen: Array<{ path: unknown; topic: unknown; body: string }> = []
    const sessions = new Set<unknown>()
    server.on('stream', (stream, headers) => {
      sessions.add(stream.session)
      let body = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => { body += chunk })
      stream.on('end', () => {
        seen.push({ path: headers[':path'], topic: headers['apns-topic'], body })
        const refused = headers[':path'] === '/refuse'
        stream.respond({ ':status': refused ? 400 : 200 })
        stream.end(refused ? JSON.stringify({ reason: 'BadDeviceToken' }) : undefined)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const post = http2Poster(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    expect(await post('/ok', { 'apns-topic': 'x' }, '{"a":1}')).toEqual({ status: 200 })
    expect(await post('/refuse', {}, '{}')).toEqual({ status: 400, reason: 'BadDeviceToken' })
    expect(seen[0]).toEqual({ path: '/ok', topic: 'x', body: '{"a":1}' })
    expect(sessions.size).toBe(1)
    for (const session of sessions) (session as http2.ServerHttp2Session).destroy()
    await new Promise((resolve) => server.close(resolve))
  })
})

describe('xcconfigValue', () => {
  it('reads a setting and skips comments', () => {
    const text = '// DEVELOPMENT_TEAM = no\nDEVELOPMENT_TEAM = ABC123\nPRODUCT_BUNDLE_IDENTIFIER = com.a.b\n'
    expect(xcconfigValue(text, 'DEVELOPMENT_TEAM')).toBe('ABC123')
    expect(xcconfigValue(text, 'MISSING')).toBeUndefined()
  })
})
