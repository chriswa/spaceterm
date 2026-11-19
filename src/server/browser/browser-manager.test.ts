import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserManager, isPlaceholderTitle, type BrowserManagerDeps } from './browser-manager'
import { BrowserUnavailableError } from './chrome-endpoints'
import type { CdpConnection, CdpEvent } from './cdp'
import type { BrowserNodeData } from '../../shared/state'
import type { BrowserFrameMessage, BrowserStatusMessage } from '../../shared/protocol'
import type { BrowserProfile } from '../../shared/browser'
import { asNodeId, ROOT_NODE_ID, type NodeId } from '../../shared/ids'

/** A browser that answers every command, and whose screenshots are whatever `screen` says. */
class FakeChrome implements CdpConnection {
  readonly sent: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = []
  screen = 'frame-1'
  private targets = 0
  private readonly events = new Set<(event: CdpEvent) => void>()
  private readonly closers = new Set<() => void>()

  send<T>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    this.sent.push({ method, params: params as Record<string, unknown>, sessionId })
    switch (method) {
      case 'Target.createTarget': return Promise.resolve({ targetId: `target-${++this.targets}` } as T)
      case 'Target.attachToTarget': return Promise.resolve({ sessionId: `session-${(params as { targetId: string }).targetId}` } as T)
      case 'Page.captureScreenshot': return Promise.resolve({ data: this.screen } as T)
      case 'Browser.getVersion': return Promise.resolve({ userAgent: 'Mozilla/5.0 HeadlessChrome/157.0' } as T)
      case 'Page.getNavigationHistory': return Promise.resolve({ currentIndex: 1, entries: [{ id: 10 }, { id: 11 }, { id: 12 }] } as T)
      default: return Promise.resolve({} as T)
    }
  }
  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.events.add(listener)
    return () => this.events.delete(listener)
  }
  onClose(listener: () => void): () => void {
    this.closers.add(listener)
    return () => this.closers.delete(listener)
  }
  close(): void { for (const fn of this.closers) fn() }
  emit(event: CdpEvent): void { for (const fn of this.events) fn(event) }
  calls(method: string) { return this.sent.filter((c) => c.method === method) }
}

const PAGE = asNodeId('page')

function browserNode(overrides: Partial<BrowserNodeData> = {}): BrowserNodeData {
  return {
    id: PAGE, type: 'browser', parentId: ROOT_NODE_ID, x: 0, y: 0, zIndex: 1, archivedChildren: [],
    profile: 'chrome', url: 'https://example.com/', title: '', width: 1280, height: 800,
    ...overrides
  }
}

function harness(opts: { node?: BrowserNodeData; connect?: (profile: BrowserProfile) => Promise<CdpConnection> } = {}) {
  const chrome = new FakeChrome()
  const nodes = new Map<NodeId, BrowserNodeData>([[PAGE, opts.node ?? browserNode()]])
  const frames: Array<{ clientId: string; frame: BrowserFrameMessage }> = []
  const statuses: Array<{ clientId: string; status: BrowserStatusMessage['status'] }> = []
  const pageChanges: Array<{ nodeId: NodeId; patch: { url?: string; title?: string } }> = []
  const deps: BrowserManagerDeps = {
    connect: opts.connect ?? (async () => chrome),
    targetStyle: (profile) => (profile === 'chrome' ? 'hidden' : 'window'),
    getNode: (id) => nodes.get(id),
    pageChanged: (nodeId, patch) => pageChanges.push({ nodeId, patch }),
    sendFrame: (clientId, frame) => frames.push({ clientId, frame }),
    sendStatus: (clientId, msg) => statuses.push({ clientId, status: msg.status }),
    log: () => undefined
  }
  const manager = new BrowserManager(deps)
  return { chrome, nodes, frames, statuses, pageChanges, manager }
}

/**
 * Run the timers and the promise chains they start, until the page loop has
 * had its turn. A real `setImmediate` between steps lets every pending promise
 * job finish first, however long the chain; each step moves the clock a
 * millisecond, since the fake clock puts a zero-delay timer set during a tick
 * one millisecond out.
 */
async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setImmediate(resolve))
    await vi.advanceTimersByTimeAsync(1)
  }
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }))
afterEach(() => vi.useRealTimers())

describe('opening a page', () => {
  it("keeps the user's Chrome page out of their tab strip, and the Spaceterm browser's in a window of its own", async () => {
    const chromeCard = harness()
    chromeCard.manager.watch('desk', PAGE, { live: false, scale: 1 })
    await settle()
    expect(chromeCard.chrome.calls('Target.createTarget')[0].params).toEqual({ url: 'https://example.com/', hidden: true, background: true })

    const isolatedCard = harness({ node: browserNode({ profile: 'isolated' }) })
    isolatedCard.manager.watch('desk', PAGE, { live: false, scale: 1 })
    await settle()
    expect(isolatedCard.chrome.calls('Target.createTarget')[0].params).toEqual({ url: 'https://example.com/', newWindow: true, background: true })
    // Headless Chrome is not allowed to say so.
    expect(isolatedCard.chrome.calls('Emulation.setUserAgentOverride')[0].params).toEqual({ userAgent: 'Mozilla/5.0 Chrome/157.0' })
  })

  it('opens nothing until someone watches, and tells watchers when it is ready', async () => {
    const h = harness()
    await settle(5_000)
    expect(h.chrome.sent).toEqual([])
    h.manager.watch('desk', PAGE, { live: false, scale: 1 })
    await settle()
    expect(h.statuses.map((s) => s.status.kind)).toEqual(['connecting', 'connecting', 'ready'])
  })

  it("shows why a browser cannot be reached, and does not retry until asked again", async () => {
    let attempts = 0
    const h = harness({
      connect: async () => {
        attempts++
        throw new BrowserUnavailableError('Turn on remote debugging.')
      }
    })
    h.manager.watch('desk', PAGE, { live: false, scale: 1 })
    await settle(30_000)
    expect(attempts).toBe(1)
    expect(h.statuses.at(-1)?.status).toEqual({ kind: 'unavailable', reason: 'Turn on remote debugging.' })

    h.manager.history(PAGE, 'reload')
    await settle()
    expect(attempts).toBe(2)
  })

  it('opens one connection per browser however many cards open at once', async () => {
    let connects = 0
    const chrome = new FakeChrome()
    const h = harness({ connect: async () => { connects++; return chrome } })
    const second = asNodeId('second')
    h.nodes.set(second, browserNode({ id: second }))
    h.manager.watch('desk', PAGE, { live: false, scale: 1 })
    h.manager.watch('desk', second, { live: false, scale: 1 })
    await settle()
    expect(connects).toBe(1)
    expect(chrome.calls('Target.createTarget')).toHaveLength(2)
  })
})

describe('frames', () => {
  it('sends a live viewer each new frame once it has acknowledged the last', async () => {
    const h = harness()
    h.manager.watch('desk', PAGE, { live: true, scale: 2 })
    await settle()
    expect(h.frames).toHaveLength(1)
    expect(h.frames[0].frame).toMatchObject({ nodeId: PAGE, data: 'frame-1', width: 1280, height: 800 })

    h.chrome.screen = 'frame-2'
    await settle(1_000)
    expect(h.frames).toHaveLength(1)

    h.manager.ack('desk', PAGE)
    await settle(100)
    expect(h.frames.map((f) => f.frame.data)).toEqual(['frame-1', 'frame-2'])
  })

  it('does not resend a frame that has not changed', async () => {
    const h = harness()
    h.manager.watch('desk', PAGE, { live: true, scale: 1 })
    await settle()
    h.manager.ack('desk', PAGE)
    await settle(2_000)
    expect(h.frames).toHaveLength(1)
  })

  it('refreshes a thumbnail rarely', async () => {
    const h = harness()
    h.manager.watch('phone', PAGE, { live: false, scale: 1 })
    await settle()
    h.manager.ack('phone', PAGE)
    h.chrome.screen = 'frame-2'
    await settle(5_000)
    expect(h.frames).toHaveLength(1)
    await settle(15_000)
    expect(h.frames.map((f) => f.frame.data)).toEqual(['frame-1', 'frame-2'])
  })

  it('renders at the sharpest scale a live viewer asked for, and at thumbnail scale with none', async () => {
    const h = harness()
    h.manager.watch('phone', PAGE, { live: false, scale: 3 })
    await settle()
    expect(h.chrome.calls('Emulation.setDeviceMetricsOverride').at(-1)?.params).toMatchObject({ deviceScaleFactor: 0.5 })
    h.manager.watch('desk', PAGE, { live: true, scale: 1.5 })
    await settle()
    expect(h.chrome.calls('Emulation.setDeviceMetricsOverride').at(-1)?.params).toMatchObject({ width: 1280, height: 800, deviceScaleFactor: 1.5 })
  })

  it("lends the page to a viewer that borrows its size, and gives it back when that viewer goes", async () => {
    const h = harness()
    h.manager.watch('desk', PAGE, { live: false, scale: 1 })
    h.manager.watch('phone', PAGE, { live: true, scale: 2, viewport: { width: 390, height: 700, mobile: true } })
    await settle()
    expect(h.chrome.calls('Emulation.setDeviceMetricsOverride').at(-1)?.params).toEqual({ width: 390, height: 700, deviceScaleFactor: 2, mobile: true })
    expect(h.chrome.calls('Emulation.setTouchEmulationEnabled').at(-1)?.params).toEqual({ enabled: true, maxTouchPoints: 5 })

    h.manager.dropClient('phone')
    h.chrome.screen = 'frame-2'
    await settle(16_000)
    expect(h.chrome.calls('Emulation.setDeviceMetricsOverride').at(-1)?.params).toEqual({ width: 1280, height: 800, deviceScaleFactor: 0.5, mobile: false })
  })
})

describe('the page', () => {
  it('saves where the page went and what it is called', async () => {
    const h = harness()
    h.manager.watch('desk', PAGE, { live: false, scale: 1 })
    await settle()
    h.chrome.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: { targetId: 'target-1', url: 'https://example.com/next', title: 'Next' } } })
    expect(h.pageChanges).toEqual([{ nodeId: PAGE, patch: { url: 'https://example.com/next', title: 'Next' } }])
  })

  it("does not save Chrome's stand-in title, the address, as the page's", async () => {
    const h = harness()
    h.manager.watch('desk', PAGE, { live: false, scale: 1 })
    await settle()
    h.chrome.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: { targetId: 'target-1', url: 'https://example.com/', title: 'example.com' } } })
    expect(h.pageChanges).toEqual([])
    expect(isPlaceholderTitle('iana.org/help/example-domains', 'https://www.iana.org/help/example-domains')).toBe(true)
    expect(isPlaceholderTitle('Example Domains', 'https://www.iana.org/help/example-domains')).toBe(false)
  })

  it('opens a popup in the card instead, and closes the popup', async () => {
    const h = harness()
    h.manager.watch('desk', PAGE, { live: false, scale: 1 })
    await settle()
    h.chrome.emit({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'popup', openerId: 'target-1', type: 'page', url: '' } } })
    h.chrome.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: { targetId: 'popup', url: 'https://example.com/elsewhere', title: '' } } })
    await settle()
    expect(h.chrome.calls('Target.closeTarget').map((c) => c.params)).toEqual([{ targetId: 'popup' }])
    expect(h.chrome.calls('Page.navigate').map((c) => c.params)).toEqual([{ url: 'https://example.com/elsewhere' }])
  })

  it('dismisses a dialog nobody can answer', async () => {
    const h = harness()
    h.manager.watch('desk', PAGE, { live: false, scale: 1 })
    await settle()
    h.chrome.emit({ method: 'Page.javascriptDialogOpening', params: {}, sessionId: 'session-target-1' })
    expect(h.chrome.calls('Page.handleJavaScriptDialog')[0]).toMatchObject({ params: { accept: false }, sessionId: 'session-target-1' })
  })

  it('goes back a step in history', async () => {
    const h = harness()
    h.manager.watch('desk', PAGE, { live: false, scale: 1 })
    await settle()
    h.manager.history(PAGE, 'back')
    await settle()
    expect(h.chrome.calls('Page.navigateToHistoryEntry')[0].params).toEqual({ entryId: 10 })
  })

  it('names the editing command for ⌘ shortcuts, which a page never sees as keys', async () => {
    const h = harness()
    h.manager.watch('desk', PAGE, { live: true, scale: 1 })
    await settle()
    h.manager.input(PAGE, { kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 4 })
    h.manager.input(PAGE, { kind: 'key', type: 'keyDown', key: 'b', code: 'KeyB', keyCode: 66, text: 'b', modifiers: 0 })
    await settle()
    expect(h.chrome.calls('Input.dispatchKeyEvent').map((c) => c.params)).toEqual([
      { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4, commands: ['selectAll'] },
      { type: 'keyDown', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66, modifiers: 0, text: 'b', unmodifiedText: 'b' }
    ])
  })

  it('closes the page when its card goes', async () => {
    const h = harness()
    h.manager.watch('desk', PAGE, { live: false, scale: 1 })
    await settle()
    h.manager.forget(PAGE)
    expect(h.chrome.calls('Target.closeTarget').map((c) => c.params)).toEqual([{ targetId: 'target-1' }])
  })

  it('reports a lost browser, and reopens the page when asked', async () => {
    const h = harness()
    h.manager.watch('desk', PAGE, { live: false, scale: 1 })
    await settle()
    h.chrome.close()
    expect(h.statuses.at(-1)?.status.kind).toBe('unavailable')
    h.manager.history(PAGE, 'reload')
    await settle()
    expect(h.chrome.calls('Target.createTarget')).toHaveLength(2)
    expect(h.statuses.at(-1)?.status.kind).toBe('ready')
  })
})
