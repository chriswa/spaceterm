import { describe, it, afterEach } from 'vitest'
import * as net from 'net'
import { join } from 'path'
import { e2eBlocker, launchApp, type LaunchedApp } from './electron-app'

/**
 * The toolbar's notification history, end to end: an agent's `notify_user`
 * arrives on the scripts socket, the real server records it, and the toolbar
 * lists it. This run's home has no APNs key and no phone, so it is listed as
 * not delivered.
 */

const blocker = e2eBlocker()
const describeE2E = blocker ? describe.skip : describe

if (blocker) console.warn(`[e2e] skipping: ${blocker}`)

let launched: LaunchedApp | null = null

afterEach(async () => {
  await launched?.close()
  launched = null
})

/** What the MCP server's notify_user sends, against this run's isolated home. */
function notify(home: string, surfaceId: string, body: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(join(home, 'scripts.sock'))
    socket.setEncoding('utf8')
    let buf = ''
    socket.on('data', (chunk: string) => {
      buf += chunk
      const line = buf.split('\n').find((l) => l.includes('script-notify-result'))
      if (line) { resolve(JSON.parse(line)); socket.destroy() }
    })
    socket.on('error', reject)
    socket.write(JSON.stringify({ type: 'script-notify', seq: 1, surfaceId, body }) + '\n')
  })
}

describeE2E('notification history', () => {
  it('lists a notification an agent sent, and adds one while open', async () => {
    launched = await launchApp()
    const { window } = launched
    await window.waitForSelector('.canvas-viewport', { timeout: 60_000 })
    const sessionId = await window.evaluate(async () => {
      const { sessionId } = await window.api.node.terminalCreate('root' as never)
      return sessionId as string
    })
    await notify(launched.home, sessionId, 'First')

    await window.click('[aria-label="Notifications"]')
    await window.waitForSelector('.event-log__row:has-text("Manual"):has-text("not delivered")', { timeout: 30_000 })

    await notify(launched.home, sessionId, 'Second')
    await window.waitForFunction(() => document.querySelectorAll('.toolbar__menu--notifications .event-log__row').length === 2, undefined, { timeout: 30_000 })
    await window.screenshot({ path: process.env.SPACETERM_E2E_SHOT ?? join(launched.home, 'notifications.png') })
  })
})
