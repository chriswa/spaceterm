import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import { WebSocket } from 'ws'
import { startWebGateway, resolveStatic, loadOrCreateWebToken } from './web-gateway'
import type { ClientLink } from './client-link'

const TOKEN = 'a'.repeat(32)
let root: string
let server: Server
let base: string
const received: string[] = []
let lastLink: ClientLink | null = null
let closes = 0

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-gateway-'))
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>app</title>')
  fs.mkdirSync(path.join(root, 'assets'))
  fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log(1)')
  fs.writeFileSync(path.join(root, 'build.json'), '{"web":"x"}')
  fs.writeFileSync(path.join(os.tmpdir(), 'web-gateway-secret.txt'), 'secret')
  server = startWebGateway({
    port: 0,
    staticRoot: root,
    token: TOKEN,
    accept: (link) => {
      lastLink = link
      return { feed: (data) => received.push(data), close: () => { closes++ } }
    },
    log: () => undefined
  })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.close()
  fs.rmSync(root, { recursive: true, force: true })
})

function open(query: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${base}/ws${query}`)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
  })
}

describe('the socket', () => {
  it('refuses a connection without the token', async () => {
    await expect(open('')).rejects.toThrow('401')
    await expect(open('?token=' + 'b'.repeat(32))).rejects.toThrow('401')
  })

  it('admits one with it, and carries lines both ways', async () => {
    const ws = await open('?token=' + TOKEN)
    const fromServer = new Promise<string>((resolve) => ws.once('message', (d) => resolve(d.toString())))
    lastLink!.write('{"type":"root-cwd"}\n')
    expect(await fromServer).toBe('{"type":"root-cwd"}\n')

    ws.send('{"type":"list","seq":1}\n')
    await new Promise((r) => setTimeout(r, 50))
    expect(received).toContain('{"type":"list","seq":1}\n')

    const before = closes
    ws.close()
    await new Promise((r) => setTimeout(r, 50))
    expect(closes).toBe(before + 1)
  })
})

describe('the app', () => {
  it('serves the page and its assets', async () => {
    const page = await fetch(`http://${base}/`)
    expect(page.status).toBe(200)
    expect(page.headers.get('cache-control')).toBe('no-cache')
    expect(await page.text()).toContain('<title>app</title>')

    const asset = await fetch(`http://${base}/assets/app.js`)
    expect(asset.headers.get('content-type')).toMatch(/javascript/)
    expect(asset.headers.get('cache-control')).toMatch(/immutable/)
  })

  it('caches only the content-named assets: build.json changes under its name', async () => {
    const version = await fetch(`http://${base}/build.json`)
    expect(version.headers.get('cache-control')).toBe('no-cache')
    expect(await version.json()).toEqual({ web: 'x' })
  })

  it('never serves a file outside its root', () => {
    expect(resolveStatic(root, '/../web-gateway-secret.txt')).toBe(path.join(root, 'index.html'))
    expect(resolveStatic(root, '/%2e%2e/web-gateway-secret.txt')).toBe(path.join(root, 'index.html'))
  })
})

describe('loadOrCreateWebToken', () => {
  it('mints an owner-only token once, then keeps it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-token-'))
    const first = loadOrCreateWebToken(dir)
    expect(first.length).toBeGreaterThanOrEqual(32)
    expect(fs.statSync(path.join(dir, 'web-token')).mode & 0o777).toBe(0o600)
    expect(loadOrCreateWebToken(dir)).toBe(first)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
