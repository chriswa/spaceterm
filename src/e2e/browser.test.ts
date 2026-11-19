import { describe, it, expect, afterEach } from 'vitest'
import * as http from 'http'
import * as net from 'net'
import { existsSync } from 'fs'
import { join } from 'path'
import type { AddressInfo } from 'net'
import { e2eBlocker, launchApp, type LaunchedApp } from './electron-app'
import { CHROME_BINARY } from '../server/browser/chrome-endpoints'

/**
 * A browser card, end to end: an agent opens a page through the scripts
 * socket, the server opens it in its own headless Chrome, and the canvas
 * draws its frames and learns its title.
 *
 * Only the `isolated` profile: the `chrome` one is the operator's own Chrome,
 * which a test run must never touch.
 */

const blocker = e2eBlocker() ?? (existsSync(CHROME_BINARY) ? null : `no Google Chrome at ${CHROME_BINARY}`)
const describeE2E = blocker ? describe.skip : describe

if (blocker) console.warn(`[e2e] skipping: ${blocker}`)

let launched: LaunchedApp | null = null
let site: http.Server | null = null

afterEach(async () => {
  await launched?.close()
  launched = null
  site?.close()
  site = null
})

function request(home: string, message: Record<string, unknown>, replyType: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(join(home, 'scripts.sock'))
    socket.setEncoding('utf8')
    let buf = ''
    socket.on('data', (chunk: string) => {
      buf += chunk
      const line = buf.split('\n').find((l) => l.includes(replyType))
      if (line) { resolve(JSON.parse(line)); socket.destroy() }
    })
    socket.on('error', reject)
    socket.write(JSON.stringify({ seq: 1, ...message }) + '\n')
  })
}

async function serve(html: string): Promise<string> {
  site = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(html)
  })
  await new Promise<void>((resolve) => site!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(site.address() as AddressInfo).port}/`
}

describeE2E('browser cards', () => {
  it("opens an agent's page in the Spaceterm browser, and shows it on the canvas with its title", async () => {
    const url = await serve('<title>Spaceterm e2e page</title><body style="background:#c33">Hello</body>')
    launched = await launchApp()
    await launched.window.waitForSelector('.canvas-viewport', { timeout: 60_000 })

    const reply = await request(launched.home, { type: 'script-add-browser', parentId: 'root', url, profile: 'isolated' }, 'script-add-browser-result')
    expect(reply.error).toBeUndefined()
    const card = `.card-shell[data-node-id="${String(reply.nodeId)}"]`

    await launched.window.waitForSelector(`${card} .browser-card__frame`, { timeout: 60_000 })
    await launched.window.waitForSelector(`${card} .browser-card__title:has-text("Spaceterm e2e page")`, { timeout: 30_000 })

    const moved = await request(launched.home, { type: 'script-navigate-browser', nodeId: reply.nodeId, url: `${url}?again` }, 'script-navigate-browser-result')
    expect(moved).toEqual(expect.objectContaining({ ok: true }))
  }, 120_000)
})
