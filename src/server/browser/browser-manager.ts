import type { CdpConnection, CdpEvent } from './cdp'
import { BrowserUnavailableError } from './chrome-endpoints'
import type { NodeId } from '../../shared/ids'
import type { BrowserNodeData } from '../../shared/state'
import type { BrowserFrameMessage, BrowserStatusMessage } from '../../shared/protocol'
import {
  BROWSER_MODIFIERS,
  isBrowsableUrl,
  type BrowserHistoryAction,
  type BrowserInput,
  type BrowserProfile,
  type BrowserStatus,
  type BrowserViewport
} from '../../shared/browser'

/**
 * The pages behind browser cards, and the frames and input that pass between
 * them and the clients watching.
 *
 * ## Frames are screenshots, not a screencast
 *
 * CDP's screencast only produces frames while Chrome is painting the page, and
 * Chrome stops painting a page nobody can see — a background tab, a minimised
 * window, or the hidden targets the user's own Chrome keeps these pages in.
 * `Page.captureScreenshot` makes Chrome paint on demand instead, whether the
 * page is visible or not, in about 25 ms. So a card's frames are screenshots
 * taken on a timer: quickly while someone is using the page (`live`), rarely
 * for a thumbnail, and less often while the page is not changing.
 *
 * ## One page, many viewers
 *
 * Every client sees the same page. The page's resolution is the highest any
 * live viewer asked for (its device scale factor), and its size is the
 * card's, unless a viewer borrowed another (the phone does, to lay the page
 * out for its screen). Frames go to each viewer only once it has acknowledged
 * the last, so a slow link gets fewer frames rather than a backlog.
 */

/** Fastest a live page is captured: what feels interactive without a core spent on screenshots. */
const LIVE_FRAME_MS = 66
/** A live page that has stopped changing is captured progressively less often, down to this. */
const LIVE_IDLE_MAX_MS = 500
/** A thumbnail is refreshed at least this often while anything is watching it. */
const THUMBNAIL_REFRESH_MS = 15_000
/** How often a page with only thumbnail viewers checks whether it owes one a frame. */
const THUMBNAIL_TICK_MS = 1_000
/** A page that loaded keeps drawing for a while after its load event; take another look this much later. */
const SETTLE_LOOK_MS = 1_500
/** Resolution for thumbnails, and the floor and ceiling for a live viewer's request. */
const THUMBNAIL_SCALE = 0.5
const MIN_SCALE = 0.25
const MAX_SCALE = 3
/** An unacknowledged frame is given up on after this, so a client that died mid-frame does not stall a page. */
const ACK_TIMEOUT_MS = 5_000
const JPEG_QUALITY = 70

export interface BrowserManagerDeps {
  /** A browser-level connection for the profile. Throws `BrowserUnavailableError` with words for the user. */
  connect(profile: BrowserProfile): Promise<CdpConnection>
  /**
   * How a page is opened in that browser: `hidden`, a target with no window or
   * tab (the user's Chrome, whose tab strip it must stay out of); or `window`,
   * a window of its own (a headless browser, where a window is never seen and
   * keeps the page counted as visible).
   */
  targetStyle(profile: BrowserProfile): 'hidden' | 'window'
  getNode(nodeId: NodeId): BrowserNodeData | undefined
  /** The page navigated or retitled: persist it on the node. */
  pageChanged(nodeId: NodeId, patch: { url?: string; title?: string }): void
  sendFrame(clientId: string, frame: BrowserFrameMessage): void
  sendStatus(clientId: string, status: BrowserStatusMessage): void
  log(line: string): void
}

interface Watcher {
  live: boolean
  scale: number
  viewport?: BrowserViewport
  /** When this client last sent `browser-watch`, so the latest borrower's viewport wins. */
  watchedAt: number
  awaitingAckSince: number | null
  lastData?: string
  lastSentAt: number
}

interface Page {
  nodeId: NodeId
  profile: BrowserProfile
  watchers: Map<string, Watcher>
  status: BrowserStatus
  conn?: CdpConnection
  targetId?: string
  sessionId?: string
  opening?: Promise<void>
  /** Set by a failed open; cleared when a client asks again, so a refusal is not retried in a loop. */
  failed: boolean
  /** The emulation last applied, as a key, so it is only sent when it changes. */
  emulation?: string
  /** The viewport last applied, which every frame since shows. */
  viewport: BrowserViewport
  /** Something may have changed since the last capture. */
  dirty: boolean
  lastCaptureAt: number
  lastCaptureData?: string
  /** Live captures in a row that came back unchanged. */
  unchangedStreak: number
  timer?: ReturnType<typeof setTimeout>
  capturing: boolean
}

export class BrowserManager {
  private readonly pages = new Map<NodeId, Page>()
  private readonly connections = new Map<BrowserProfile, Promise<CdpConnection>>()
  /** Popups a page opened, by target id, until they have a URL to send their opener to. */
  private readonly popups = new Map<string, NodeId>()
  private disposed = false

  constructor(private readonly deps: BrowserManagerDeps) {}

  // ─── what clients ask for ────────────────────────────────────────────────

  watch(clientId: string, nodeId: NodeId, opts: { live: boolean; scale: number; viewport?: BrowserViewport }, now = Date.now()): void {
    const node = this.deps.getNode(nodeId)
    if (!node) return
    const page = this.pageFor(node)
    const previous = page.watchers.get(clientId)
    page.watchers.set(clientId, {
      live: opts.live,
      scale: clampScale(opts.scale),
      viewport: validViewport(opts.viewport),
      watchedAt: now,
      awaitingAckSince: null,
      // Kept across a re-watch, so going live does not resend the frame the client already has.
      lastData: previous?.lastData,
      lastSentAt: previous?.lastSentAt ?? 0
    })
    page.failed = false
    page.dirty = true
    page.unchangedStreak = 0
    this.deps.sendStatus(clientId, { type: 'browser-status', nodeId, status: page.status })
    this.schedule(page, 0)
  }

  unwatch(clientId: string, nodeId: NodeId): void {
    const page = this.pages.get(nodeId)
    if (!page?.watchers.delete(clientId)) return
    this.schedule(page, 0)
  }

  /** A client went away: everything it was watching. */
  dropClient(clientId: string): void {
    for (const page of this.pages.values()) {
      if (page.watchers.delete(clientId)) this.schedule(page, 0)
    }
  }

  ack(clientId: string, nodeId: NodeId): void {
    const page = this.pages.get(nodeId)
    const watcher = page?.watchers.get(clientId)
    if (!page || !watcher) return
    watcher.awaitingAckSince = null
    if (watcher.live) this.schedule(page, 0)
  }

  input(nodeId: NodeId, input: BrowserInput): void {
    const page = this.pages.get(nodeId)
    if (!page?.conn || !page.sessionId) return
    page.dirty = true
    page.unchangedStreak = 0
    void this.dispatchInput(page, input).catch((err) => this.deps.log(`[browser] input to ${nodeId} failed: ${messageOf(err)}`))
    this.schedule(page, LIVE_FRAME_MS)
  }

  history(nodeId: NodeId, action: BrowserHistoryAction): void {
    const page = this.pages.get(nodeId)
    if (!page) return
    // Reload is also how a card that could not open asks to try again.
    if (!page.sessionId) {
      if (action === 'reload') {
        page.failed = false
        this.schedule(page, 0)
      }
      return
    }
    const { conn, sessionId } = page
    void (async () => {
      if (action === 'reload') {
        await conn!.send('Page.reload', {}, sessionId)
        return
      }
      const history = await conn!.send<{ currentIndex: number; entries: { id: number }[] }>('Page.getNavigationHistory', {}, sessionId)
      const entry = history.entries[history.currentIndex + (action === 'back' ? -1 : 1)]
      if (entry) await conn!.send('Page.navigateToHistoryEntry', { entryId: entry.id }, sessionId)
    })().catch((err) => this.deps.log(`[browser] ${action} on ${nodeId} failed: ${messageOf(err)}`))
  }

  /** Send a card's page somewhere. Its node's `url` is the caller's to set; an unopened page opens there. */
  navigate(nodeId: NodeId, url: string): void {
    if (!isBrowsableUrl(url)) return
    const page = this.pages.get(nodeId)
    if (!page?.conn || !page.sessionId) return
    page.dirty = true
    void page.conn.send('Page.navigate', { url }, page.sessionId)
      .catch((err) => this.deps.log(`[browser] navigating ${nodeId} failed: ${messageOf(err)}`))
  }

  /** The card is gone (archived or deleted): close its page. It reopens from its URL if the card comes back. */
  forget(nodeId: NodeId): void {
    const page = this.pages.get(nodeId)
    if (!page) return
    this.pages.delete(nodeId)
    clearTimeout(page.timer)
    this.closeTarget(page)
  }

  async shutdown(): Promise<void> {
    this.disposed = true
    for (const page of this.pages.values()) {
      clearTimeout(page.timer)
      this.closeTarget(page)
    }
    this.pages.clear()
  }

  // ─── pages ───────────────────────────────────────────────────────────────

  private pageFor(node: BrowserNodeData): Page {
    let page = this.pages.get(node.id)
    if (!page) {
      page = {
        nodeId: node.id,
        profile: node.profile,
        watchers: new Map(),
        status: { kind: 'connecting' },
        failed: false,
        viewport: { width: node.width, height: node.height, mobile: false },
        dirty: true,
        lastCaptureAt: 0,
        unchangedStreak: 0,
        capturing: false
      }
      this.pages.set(node.id, page)
    }
    return page
  }

  private setStatus(page: Page, status: BrowserStatus): void {
    page.status = status
    for (const clientId of page.watchers.keys()) {
      this.deps.sendStatus(clientId, { type: 'browser-status', nodeId: page.nodeId, status })
    }
  }

  private connection(profile: BrowserProfile): Promise<CdpConnection> {
    let pending = this.connections.get(profile)
    if (!pending) {
      pending = this.deps.connect(profile).then(async (conn) => {
        conn.onEvent((event) => this.handleEvent(profile, event))
        conn.onClose(() => this.connectionLost(profile, conn))
        await conn.send('Target.setDiscoverTargets', { discover: true })
        return conn
      })
      pending.catch(() => this.connections.delete(profile))
      this.connections.set(profile, pending)
    }
    return pending
  }

  private connectionLost(profile: BrowserProfile, conn: CdpConnection): void {
    this.connections.delete(profile)
    for (const page of this.pages.values()) {
      if (page.conn !== conn) continue
      page.conn = undefined
      page.targetId = undefined
      page.sessionId = undefined
      page.emulation = undefined
      this.setStatus(page, { kind: 'unavailable', reason: 'The browser closed. Click Reload on this card to open the page again.' })
      page.failed = true
    }
  }

  private open(page: Page): Promise<void> {
    if (!page.opening) {
      page.opening = this.openTarget(page).then(
        () => {
          page.opening = undefined
          this.setStatus(page, { kind: 'ready' })
        },
        (err) => {
          page.opening = undefined
          page.failed = true
          const reason = err instanceof BrowserUnavailableError ? err.message : `The page could not be opened: ${messageOf(err)}`
          this.deps.log(`[browser] opening ${page.nodeId} failed: ${messageOf(err)}`)
          this.setStatus(page, { kind: 'unavailable', reason })
        }
      )
    }
    return page.opening
  }

  private async openTarget(page: Page): Promise<void> {
    this.setStatus(page, {
      kind: 'connecting',
      ...(page.profile === 'chrome' && !this.connections.has('chrome') ? { detail: 'If Chrome asks whether to allow remote debugging, allow it.' } : {})
    })
    const conn = await this.connection(page.profile)
    const node = this.deps.getNode(page.nodeId)
    if (!node || this.pages.get(page.nodeId) !== page) return
    const url = isBrowsableUrl(node.url) ? node.url : 'about:blank'
    const style = this.deps.targetStyle(page.profile)
    const { targetId } = await conn.send<{ targetId: string }>(
      'Target.createTarget',
      style === 'hidden' ? { url, hidden: true, background: true } : { url, newWindow: true, background: true }
    )
    const { sessionId } = await conn.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
    // Forgotten while opening: do not leave a page behind for a card that is gone.
    if (this.pages.get(page.nodeId) !== page || this.disposed) {
      void conn.send('Target.closeTarget', { targetId }).catch(() => undefined)
      return
    }
    page.conn = conn
    page.targetId = targetId
    page.sessionId = sessionId
    page.emulation = undefined
    await conn.send('Page.enable', {}, sessionId)
    // A page that is never on screen still believes it has focus, so caret and focus styles show.
    await conn.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId)
    if (style === 'window') {
      // Headless Chrome says so in its user agent, and some sites turn it away for that.
      const { userAgent } = await conn.send<{ userAgent: string }>('Browser.getVersion')
      await conn.send('Emulation.setUserAgentOverride', { userAgent: userAgent.replace('HeadlessChrome', 'Chrome') }, sessionId)
    }
    await this.applyEmulation(page)
  }

  private closeTarget(page: Page): void {
    if (page.conn && page.targetId) {
      void page.conn.send('Target.closeTarget', { targetId: page.targetId }).catch(() => undefined)
    }
    page.conn = undefined
    page.targetId = undefined
    page.sessionId = undefined
  }

  private pageBySession(sessionId: string | undefined): Page | undefined {
    if (!sessionId) return undefined
    for (const page of this.pages.values()) if (page.sessionId === sessionId) return page
    return undefined
  }

  private pageByTarget(targetId: string): Page | undefined {
    for (const page of this.pages.values()) if (page.targetId === targetId) return page
    return undefined
  }

  private handleEvent(profile: BrowserProfile, event: CdpEvent): void {
    switch (event.method) {
      case 'Target.targetCreated': {
        // A link with target=_blank, or window.open: the page goes there instead.
        const info = event.params.targetInfo as { targetId: string; openerId?: string; type: string }
        if (info.type !== 'page' || !info.openerId) return
        const opener = this.pageByTarget(info.openerId)
        if (opener && opener.profile === profile) this.popups.set(info.targetId, opener.nodeId)
        return
      }
      case 'Target.targetInfoChanged': {
        const info = event.params.targetInfo as { targetId: string; url: string; title: string }
        const popupOwner = this.popups.get(info.targetId)
        if (popupOwner) {
          if (!info.url || info.url === 'about:blank') return
          this.popups.delete(info.targetId)
          void this.connections.get(profile)?.then((conn) => conn.send('Target.closeTarget', { targetId: info.targetId })).catch(() => undefined)
          this.navigate(popupOwner, info.url)
          return
        }
        const page = this.pageByTarget(info.targetId)
        if (!page) return
        this.recordPage(page, info)
        page.dirty = true
        return
      }
      case 'Target.targetDestroyed':
      case 'Target.detachedFromTarget': {
        const targetId = (event.params.targetId as string | undefined)
        if (targetId) this.popups.delete(targetId)
        const page = targetId ? this.pageByTarget(targetId) : this.pageBySession(event.params.sessionId as string | undefined)
        if (!page) return
        page.targetId = undefined
        page.sessionId = undefined
        page.emulation = undefined
        // Reopened from its URL by whoever next looks.
        this.setStatus(page, { kind: 'connecting' })
        this.schedule(page, 0)
        return
      }
      case 'Page.loadEventFired': {
        const page = this.pageBySession(event.sessionId)
        if (!page) return
        this.refreshPageInfo(page)
        page.dirty = true
        page.unchangedStreak = 0
        this.schedule(page, 0)
        setTimeout(() => {
          page.dirty = true
          this.schedule(page, 0)
        }, SETTLE_LOOK_MS)
        return
      }
      case 'Page.javascriptDialogOpening': {
        // Nobody can answer it, and a page with a dialog up cannot be captured.
        const page = this.pageBySession(event.sessionId)
        if (page?.conn) void page.conn.send('Page.handleJavaScriptDialog', { accept: false }, page.sessionId).catch(() => undefined)
        return
      }
    }
  }

  /** Save where a page is and what it is called, if either changed. */
  private recordPage(page: Page, info: { url: string; title: string }): void {
    const node = this.deps.getNode(page.nodeId)
    if (!node) return
    const patch: { url?: string; title?: string } = {}
    if (info.url && info.url !== node.url && isBrowsableUrl(info.url)) patch.url = info.url
    // A page still on Chrome's stand-in title keeps the one it had, unless it is a new page.
    const title = isPlaceholderTitle(info.title, info.url) ? (patch.url !== undefined ? '' : node.title) : info.title
    if (title !== node.title) patch.title = title
    if (patch.url !== undefined || patch.title !== undefined) this.deps.pageChanged(page.nodeId, patch)
  }

  /**
   * Ask for the page's address and title. Chrome does not announce every
   * title change, and a page retitles itself as it runs (an unread count, a
   * track name), so this is asked on load and with each thumbnail.
   */
  private refreshPageInfo(page: Page): void {
    const { conn, targetId } = page
    if (!conn || !targetId) return
    void conn.send<{ targetInfo: { url: string; title: string } }>('Target.getTargetInfo', { targetId })
      .then(({ targetInfo }) => { if (page.targetId === targetId) this.recordPage(page, targetInfo) })
      .catch(() => undefined)
  }

  /** The viewport and scale the watchers add up to, applied if it changed. */
  private async applyEmulation(page: Page): Promise<void> {
    const node = this.deps.getNode(page.nodeId)
    if (!node || !page.conn || !page.sessionId) return
    let borrower: Watcher | undefined
    let scale = 0
    for (const watcher of page.watchers.values()) {
      if (watcher.viewport && (!borrower || watcher.watchedAt > borrower.watchedAt)) borrower = watcher
      if (watcher.live) scale = Math.max(scale, watcher.scale)
    }
    const viewport = borrower?.viewport ?? { width: node.width, height: node.height, mobile: false }
    const deviceScaleFactor = scale || THUMBNAIL_SCALE
    const key = `${viewport.width}x${viewport.height}@${deviceScaleFactor}${viewport.mobile ? 'm' : ''}`
    if (page.emulation === key) return
    page.emulation = key
    page.viewport = viewport
    this.deps.log(`[browser] ${page.nodeId} renders at ${key}`)
    await page.conn.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor,
      mobile: viewport.mobile
    }, page.sessionId)
    await page.conn.send('Emulation.setTouchEmulationEnabled', { enabled: viewport.mobile, ...(viewport.mobile ? { maxTouchPoints: 5 } : {}) }, page.sessionId)
  }

  // ─── frames ──────────────────────────────────────────────────────────────

  private schedule(page: Page, delayMs: number): void {
    if (this.disposed || this.pages.get(page.nodeId) !== page) return
    clearTimeout(page.timer)
    page.timer = setTimeout(() => { void this.pump(page) }, delayMs)
  }

  /**
   * One turn of a page's loop: open it if it needs opening, capture a frame if
   * anyone is owed one, and decide when to look again. Stops when nobody is
   * watching; a `watch` starts it again.
   */
  private async pump(page: Page): Promise<void> {
    if (page.capturing || page.watchers.size === 0) return
    if (!page.sessionId) {
      if (!page.failed && !page.opening) {
        await this.open(page)
        if (page.sessionId) this.schedule(page, 0)
      }
      return
    }
    const now = Date.now()
    for (const watcher of page.watchers.values()) {
      if (watcher.awaitingAckSince !== null && now - watcher.awaitingAckSince > ACK_TIMEOUT_MS) watcher.awaitingAckSince = null
    }
    const owed = [...page.watchers.entries()].filter(([, w]) => this.owesFrame(page, w, now))
    if (owed.length > 0) {
      page.capturing = true
      try {
        await this.applyEmulation(page)
        const data = await this.capture(page)
        page.lastCaptureAt = Date.now()
        if (data === page.lastCaptureData) page.unchangedStreak++
        else page.unchangedStreak = 0
        page.lastCaptureData = data
        page.dirty = false
        const { width, height } = page.viewport
        if (!isLive(page)) this.refreshPageInfo(page)
        for (const [clientId, watcher] of owed) {
          if (!page.watchers.has(clientId) || data === watcher.lastData) continue
          watcher.lastData = data
          watcher.lastSentAt = page.lastCaptureAt
          watcher.awaitingAckSince = page.lastCaptureAt
          this.deps.sendFrame(clientId, { type: 'browser-frame', nodeId: page.nodeId, data, width, height })
        }
      } catch (err) {
        this.deps.log(`[browser] capturing ${page.nodeId} failed: ${messageOf(err)}`)
      } finally {
        page.capturing = false
      }
    }
    if (page.watchers.size === 0) return
    // Asked again after the capture, not before: a viewer that went live
    // during it is owed its first sharp frame now, not a thumbnail tick later.
    this.schedule(page, isLive(page) ? Math.min(LIVE_IDLE_MAX_MS, LIVE_FRAME_MS * 2 ** Math.min(page.unchangedStreak, 3)) : THUMBNAIL_TICK_MS)
  }

  private owesFrame(page: Page, watcher: Watcher, now: number): boolean {
    if (watcher.awaitingAckSince !== null) return false
    if (watcher.live) return true
    if (watcher.lastData === undefined) return true
    return page.dirty ? now - watcher.lastSentAt >= THUMBNAIL_TICK_MS : now - watcher.lastSentAt >= THUMBNAIL_REFRESH_MS
  }

  private async capture(page: Page): Promise<string> {
    const { data } = await page.conn!.send<{ data: string }>('Page.captureScreenshot', {
      format: 'jpeg',
      quality: JPEG_QUALITY,
      optimizeForSpeed: true
    }, page.sessionId)
    return data
  }

  // ─── input ───────────────────────────────────────────────────────────────

  private async dispatchInput(page: Page, input: BrowserInput): Promise<void> {
    const send = (method: string, params: object) => page.conn!.send(method, params, page.sessionId)
    switch (input.kind) {
      case 'mouse':
        await send('Input.dispatchMouseEvent', {
          type: input.type, x: input.x, y: input.y, button: input.button, clickCount: input.clickCount, modifiers: input.modifiers
        })
        return
      case 'wheel':
        await send('Input.dispatchMouseEvent', {
          type: 'mouseWheel', x: input.x, y: input.y, deltaX: input.deltaX, deltaY: input.deltaY, modifiers: input.modifiers
        })
        return
      case 'key': {
        const commands = input.type === 'keyDown' ? editingCommands(input.key, input.modifiers) : []
        await send('Input.dispatchKeyEvent', {
          // A key that types something is a keyDown with text; one that does not is a rawKeyDown.
          type: input.type === 'keyDown' ? (input.text ? 'keyDown' : 'rawKeyDown') : 'keyUp',
          key: input.key,
          code: input.code,
          windowsVirtualKeyCode: input.keyCode,
          modifiers: input.modifiers,
          ...(input.text ? { text: input.text, unmodifiedText: input.text } : {}),
          ...(commands.length ? { commands } : {})
        })
        return
      }
      case 'text':
        await send('Input.insertText', { text: input.text })
        return
      case 'tap':
        if (page.viewport.mobile) {
          await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: input.x, y: input.y }] })
          await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        } else {
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: input.x, y: input.y, button: 'left', clickCount: 1 })
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: input.x, y: input.y, button: 'left', clickCount: 1 })
        }
        return
    }
  }
}

/**
 * On a Mac, ⌘A, ⌘C and the rest are menu commands, not keys a page handles,
 * so a synthetic key event does nothing without naming the editing command.
 */
function editingCommands(key: string, modifiers: number): string[] {
  if (!(modifiers & BROWSER_MODIFIERS.meta)) return []
  switch (key.toLowerCase()) {
    case 'a': return ['selectAll']
    case 'c': return ['copy']
    case 'x': return ['cut']
    case 'v': return ['paste']
    case 'z': return [modifiers & BROWSER_MODIFIERS.shift ? 'redo' : 'undo']
    default: return []
  }
}

function isLive(page: Page): boolean {
  return [...page.watchers.values()].some((w) => w.live)
}

/** Chrome titles a page with its address, minus the scheme and `www.`, until the page gives one of its own. */
export function isPlaceholderTitle(title: string, url: string): boolean {
  if (!title) return true
  const bare = url.replace(/^[a-z]+:\/\/(www\.)?/, '').replace(/\/$/, '')
  return title === url || title === bare
}

function clampScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(scale * 4) / 4))
}

function validViewport(viewport: BrowserViewport | undefined): BrowserViewport | undefined {
  if (!viewport) return undefined
  const width = Math.round(viewport.width)
  const height = Math.round(viewport.height)
  if (!(width >= 200 && width <= 4000 && height >= 200 && height <= 4000)) return undefined
  return { width, height, mobile: viewport.mobile === true }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
