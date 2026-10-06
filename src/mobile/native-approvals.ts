/**
 * The iPhone app's approval key and slide control, as the page sees them
 * (`NativeApprovals.swift`).
 *
 * An approval request's provider — opProxy — trusts a reply only because this
 * phone's key signed it, and that key lives in the Secure Enclave where only the
 * app's native code can use it (APPROVAL_FEED.md). The page cannot have an
 * `approve` signed by asking: it *arms* the app's own panel, docked at the foot
 * of the screen, which shows the request's confirm line and chosen options from
 * the provider's document and signs only once its slider has been dragged all
 * the way across. Anything else — Deny — the app signs at once.
 *
 * In Safari there is no app, so nothing here is available and the phone can
 * look but not answer.
 */

import type { ApprovalItem, SignedApprovalReply } from '../shared/approvals'

/**
 * The panel's height above the safe area, in points. The approval view keeps
 * this much clear at its foot while armed. `NativeApprovals.swift` uses the
 * same number; change both together.
 */
export const NATIVE_PANEL_HEIGHT = 112

export interface NativeIdentity {
  keyId: string
  /** Base64 raw P-256 public key, X‖Y. */
  publicKey: string
  /** What the Mac shows when pairing, to compare: `ab12 cd34 ef56 7890`. */
  fingerprint: string
  name: string
}

/** What the app needs to know about a request; it reads the rest from the document itself. */
type NativeItem = Pick<ApprovalItem, 'id' | 'revision' | 'challenge' | 'document'> & { provider: string }

interface ReplyHandler {
  postMessage(message: unknown): Promise<unknown>
}

function handler(): ReplyHandler | undefined {
  // A handler with a reply (WKScriptMessageHandlerWithReply): postMessage returns a promise.
  return window.webkit?.messageHandlers?.approvals as ReplyHandler | undefined
}

/** Whether this page runs inside the iPhone app, which can sign an answer. */
export function nativeApprovalsAvailable(): boolean {
  return handler() !== undefined
}

function call<T>(message: Record<string, unknown>): Promise<T> {
  const h = handler()
  if (!h) return Promise.reject(new Error('Answering needs the Spaceterm iPhone app.'))
  return h.postMessage(message) as Promise<T>
}

let identity: Promise<NativeIdentity> | null = null

/** This phone's key, made on first use. */
export function nativeIdentity(): Promise<NativeIdentity> {
  identity ??= call<NativeIdentity>({ op: 'identity' }).catch((err) => {
    identity = null
    throw err
  })
  return identity
}

function nativeItem(item: ApprovalItem): NativeItem {
  return { provider: item.source, id: item.id, revision: item.revision, challenge: item.challenge, document: item.document }
}

/**
 * Shows the slide panel for an `approve` action with these picks, or updates
 * the one showing. Resolves with the signed reply once it is slid across, or
 * with null when another `armApproval` or `disarmApproval` replaces it.
 */
export function armApproval(item: ApprovalItem, action: string, picks: Record<string, string>): Promise<SignedApprovalReply | null> {
  return call<SignedApprovalReply | null>({ op: 'arm', item: nativeItem(item), action, picks })
}

/** Hides the slide panel. */
export function disarmApproval(): void {
  if (handler()) void call({ op: 'disarm' }).catch(() => undefined)
}

/** Signs an action that is not an approval — Deny — straight away. */
export function signApproval(item: ApprovalItem, action: string, picks: Record<string, string>): Promise<SignedApprovalReply> {
  return call<SignedApprovalReply>({ op: 'sign', item: nativeItem(item), action, picks })
}
