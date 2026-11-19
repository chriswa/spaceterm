/**
 * Browser cards: a web page on the canvas, driven over the Chrome DevTools
 * Protocol by the server and shown to every client as a stream of JPEG frames.
 *
 * Two profiles, which are two different cards to the user:
 *
 * - `chrome` is a tab in the Chrome the user already runs, under its default
 *   profile, so it is signed in to whatever they are. Spaceterm reaches it
 *   through the remote debugging Chrome offers at
 *   `chrome://inspect/#remote-debugging`; the tab is a hidden target, so it is
 *   never in the user's tab strip.
 * - `isolated` is a headless Chrome Spaceterm runs itself, on a profile of its
 *   own under the Spaceterm home. Nothing is shared with the user's Chrome.
 *
 * The page lives on the server's side, so the desktop and the phone show the
 * same page, and neither needs a browser engine of its own: a client asks for
 * frames (`browser-watch`) and sends input back (`browser-input`).
 */

export type BrowserProfile = 'chrome' | 'isolated'

export const BROWSER_PROFILES: readonly BrowserProfile[] = ['chrome', 'isolated']

export const BROWSER_PROFILE_LABELS: Record<BrowserProfile, string> = {
  chrome: 'Chrome',
  isolated: 'Spaceterm browser'
}

export function isBrowserProfile(value: unknown): value is BrowserProfile {
  return typeof value === 'string' && (BROWSER_PROFILES as readonly string[]).includes(value)
}

/**
 * Only pages a browser would open from its address bar. Anything else
 * (`javascript:`, `file:`, `chrome:`) is refused: an agent's URL reaches the
 * user's own signed-in Chrome.
 */
export function isBrowsableUrl(url: string): boolean {
  if (url === 'about:blank') return true
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** The page's size in CSS pixels, and whether it should lay out as a phone. */
export interface BrowserViewport {
  width: number
  height: number
  mobile: boolean
}

/**
 * What a card's page is doing, as the card should show it. Not persisted:
 * the server works it out again for whoever is watching.
 */
export type BrowserStatus =
  /** `detail` is for the user, when there is something for them to do meanwhile. */
  | { kind: 'connecting'; detail?: string }
  | { kind: 'ready' }
  /** No page can be shown, and `reason` says what the user can do about it. */
  | { kind: 'unavailable'; reason: string }

/** Modifier bits, as CDP's `Input` domain numbers them. */
export const BROWSER_MODIFIERS = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const

/**
 * Input for a page, in its own CSS pixels. Mirrors the CDP `Input` events it
 * becomes, so the server forwards rather than interprets.
 */
export type BrowserInput =
  | {
    kind: 'mouse'
    type: 'mousePressed' | 'mouseReleased' | 'mouseMoved'
    x: number
    y: number
    button: 'none' | 'left' | 'middle' | 'right'
    clickCount: number
    modifiers: number
  }
  | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number; modifiers: number }
  | {
    kind: 'key'
    type: 'keyDown' | 'keyUp'
    key: string
    code: string
    /** What the key types, if anything: a character, or Enter's carriage return. */
    text?: string
    keyCode: number
    modifiers: number
  }
  /** Typed text as one insertion, the way an IME or dictation commits it. */
  | { kind: 'text'; text: string }
  /** A tap from a touch screen, sent as one. */
  | { kind: 'tap'; x: number; y: number }

export type BrowserHistoryAction = 'back' | 'forward' | 'reload'
