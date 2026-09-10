import { describe, it, expect, afterEach } from 'vitest'
import { e2eBlocker, launchApp, type LaunchedApp } from './electron-app'

/**
 * The agent-meta branch, against a real directory on disk.
 *
 * Everything below this layer works against a fake filesystem: the scanner is
 * pure over an injected IO, the manager drives a literal tree, and the cards
 * render in jsdom from props. All of that is worth having, and none of it can
 * fail the way this can — by the three processes disagreeing about what the
 * feature *is*. The toggle crosses the preload bridge, reaches a manager that
 * reads the actual disk, materialises nodes that are deliberately never
 * persisted, and comes back as broadcasts the renderer has to turn into cards.
 *
 * The host is this repo itself, which is the point rather than a convenience:
 * it has a top-level CLAUDE.md, a second one under `.claude/`, and real skills,
 * so the layout rules are exercised against a tree nobody wrote for the test.
 * It also sits under `$HOME`, so the directory node stores its cwd
 * `~`-abbreviated — the expansion that, if it were missing, would make the
 * feature silently do nothing for most real directory nodes.
 */

const blocker = e2eBlocker()
const describeE2E = blocker ? describe.skip : describe

if (blocker) console.warn(`[e2e] skipping: ${blocker}`)

let launched: LaunchedApp | null = null

afterEach(async () => {
  await launched?.close()
  launched = null
})

/** A directory node pointing at this repo, and its node id. */
async function createHost(app: LaunchedApp, cwd: string): Promise<string> {
  await app.window.waitForSelector('.canvas-viewport', { timeout: 60_000 })
  const id = await app.window.evaluate(
    async (dir) => (await window.api.node.directoryAdd('root' as never, dir)).nodeId,
    cwd
  )
  await app.window.waitForSelector(`.card-shell[data-node-id="${id}"]`, { timeout: 30_000 })
  return id
}

describeE2E('the agent-meta branch', () => {
  it('grows cards for the real CLAUDE.md and skills of a real directory', async () => {
    launched = await launchApp()
    const host = await createHost(launched, process.cwd())

    const open = await launched.window.evaluate(
      (nodeId) => window.api.node.agentMetaToggle(nodeId as never),
      host
    )
    expect(open, 'the server found nothing to show for this repo').toBe(true)

    await launched.window.waitForSelector('.meta-group-card', { timeout: 30_000 })
    await launched.window.waitForSelector('.meta-doc-card', { timeout: 30_000 })

    const docs = await launched.window.locator('.meta-doc-card').count()
    expect(docs, 'expected a card per document and skill').toBeGreaterThan(1)
  })

  it('shows each skill by its own name, including the ones with no name: key', async () => {
    // Half the skills on this machine omit `name:` and let Claude Code take the
    // name from the directory. A card that insisted on the header would show
    // them untitled, and nothing below this layer reads the real files.
    launched = await launchApp()
    const host = await createHost(launched, process.cwd())
    await launched.window.evaluate((nodeId) => window.api.node.agentMetaToggle(nodeId as never), host)
    await launched.window.waitForSelector('.meta-doc-card__name', { timeout: 30_000 })

    const names = await launched.window.locator('.meta-doc-card__name').allInnerTexts()
    expect(names.every((n) => n.trim().length > 0), `an untitled card: ${JSON.stringify(names)}`).toBe(true)
    // `cartesia-fixup` is a skill of this repo's, and it declares a name.
    expect(names.join('\n')).toContain('cartesia-fixup')
  })

  it('takes every card away again, and leaves nothing on disk', async () => {
    // The whole safety argument in one assertion: the branch is a view, so
    // closing it must leave the document as if it had never been opened.
    launched = await launchApp()
    const host = await createHost(launched, process.cwd())

    await launched.window.evaluate((nodeId) => window.api.node.agentMetaToggle(nodeId as never), host)
    await launched.window.waitForSelector('.meta-doc-card', { timeout: 30_000 })

    const stillOpen = await launched.window.evaluate(
      (nodeId) => window.api.node.agentMetaToggle(nodeId as never),
      host
    )
    expect(stillOpen).toBe(false)

    await launched.window.waitForSelector('.meta-group-card', { state: 'detached', timeout: 30_000 })
    expect(await launched.window.locator('.meta-doc-card').count()).toBe(0)

    // The server's own view of what it would persist. Generated nodes live in
    // `state.nodes` in memory, so "no meta nodes in the synced state" is the
    // observable end of the guarantee that none of them can reach state.json.
    const persistedTypes = await launched.window.evaluate(async () => {
      const state = await window.api.node.syncRequest()
      return Object.values(state.nodes).map((n) => n.type)
    })
    expect(persistedTypes).not.toContain('meta-group')
    expect(persistedTypes).not.toContain('meta-doc')
  })
})
