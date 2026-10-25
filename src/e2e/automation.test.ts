import { describe, it, expect, afterEach } from 'vitest'
import * as net from 'net'
import { join } from 'path'
import { e2eBlocker, launchApp, type LaunchedApp } from './electron-app'

/**
 * An automation card, end to end: made through the bridge, fired from the
 * scripts socket the way an external script would, and acted on by the real
 * server.
 *
 * Every firing here lands on a card that already has a plain shell beneath
 * it, in a mode that sends or queues rather than spawns. That is deliberate:
 * a spawn would launch a real Claude Code against the operator's account.
 * Spawning is covered by `automation-runner.test.ts`; what only this layer can
 * show is that the socket, the runner and the canvas are wired together.
 */

const blocker = e2eBlocker()
const describeE2E = blocker ? describe.skip : describe

if (blocker) console.warn(`[e2e] skipping: ${blocker}`)

let launched: LaunchedApp | null = null

afterEach(async () => {
  await launched?.close()
  launched = null
})

/** What `spaceterm-cli fire` sends, against this run's isolated home. */
function fire(home: string, eventId: string, payload?: unknown): Promise<{ matched: number; error?: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(join(home, 'scripts.sock'))
    socket.setEncoding('utf8')
    let buf = ''
    socket.on('data', (chunk: string) => {
      buf += chunk
      const line = buf.split('\n').find((l) => l.includes('script-fire-event-result'))
      if (line) { resolve(JSON.parse(line)); socket.destroy() }
    })
    socket.on('error', reject)
    socket.write(JSON.stringify({ type: 'script-fire-event', seq: 1, eventId, payload }) + '\n')
  })
}

/** An automation card under the root with a plain shell beneath it. */
async function automationWithChild(app: LaunchedApp, trigger: string, overlap: 'reuse' | 'queue'): Promise<string> {
  await app.window.waitForSelector('.canvas-viewport', { timeout: 60_000 })
  const id = await app.window.evaluate(async ({ trigger, overlap }) => {
    const { nodeId } = await window.api.node.automationAdd('root' as never)
    // The shell first, so the card is never childless while it has a trigger.
    await window.api.node.terminalCreate(nodeId)
    await window.api.node.automationUpdate(nodeId, { trigger, overlap })
    return nodeId
  }, { trigger, overlap })
  await app.window.waitForSelector(`.card-shell[data-node-id="${id}"] .automation-card__trigger`, { timeout: 30_000 })
  return id
}

async function automationNode(app: LaunchedApp, id: string) {
  return app.window.evaluate(async (nodeId) => {
    const state = await window.api.node.syncRequest()
    return state.nodes[nodeId] as unknown as { lastFiredAt?: number; queue: unknown[] }
  }, id)
}

describeE2E('automation cards', () => {
  it('sends a fired event to its one child, and says no card heard a typo', async () => {
    launched = await launchApp()
    const id = await automationWithChild(launched, 'custom_e2e_reuse', 'reuse')

    expect(await fire(launched.home, 'custom_e2e_reuse', { n: 1 })).toEqual(expect.objectContaining({ matched: 1 }))
    expect((await automationNode(launched, id)).lastFiredAt).toEqual(expect.any(Number))

    // The child is a run: a gear in place of a generated icon.
    await launched.window.waitForSelector('[aria-label="Started by an automation"]', { timeout: 30_000 })

    expect(await fire(launched.home, 'custom_e2e_typo')).toEqual(expect.objectContaining({ matched: 0 }))
    expect((await fire(launched.home, 'no_prefix')).error).toContain('custom_')
  })

  it('queues firings behind a running child, shows the count, and clears it', async () => {
    launched = await launchApp()
    const id = await automationWithChild(launched, 'custom_e2e_queue', 'queue')
    const card = `.card-shell[data-node-id="${id}"]`

    await fire(launched.home, 'custom_e2e_queue', { n: 1 })
    await fire(launched.home, 'custom_e2e_queue', { n: 2 })
    expect((await automationNode(launched, id)).queue).toHaveLength(2)
    await launched.window.waitForSelector(`${card} .automation-card__queue:has-text("2 queued")`, { timeout: 30_000 })

    await launched.window.evaluate((nodeId) => window.api.node.automationClearQueue(nodeId as never), id)
    await launched.window.waitForSelector(`${card} .automation-card__queue:has-text("0 queued")`, { timeout: 30_000 })
  })
})
