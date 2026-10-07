/**
 * Approval requests from programs on the Mac that ask for them — today only
 * opProxy — as the server relays them to the phone. The feed's own protocol,
 * and why Spaceterm only relays it, is in APPROVAL_FEED.md.
 *
 * Nothing here understands a request. `document` and `challenge` travel as the
 * provider sent them, byte for byte: the phone hashes the document it shows and
 * signs that hash, so a relay that re-encoded it would break every reply.
 */

/** One program the server takes approval requests from. */
export interface ApprovalSource {
  /** The provider's name from its `hello` ("opProxy"); what replies are addressed to. */
  name: string
  connected: boolean
  /** Key IDs of the phones the provider trusts. */
  pairedKeys: string[]
  /** What the provider depends on, as its last `status` said; absent until it sends one. */
  status?: ProviderStatus
}

/** APPROVAL_FEED.md, "Provider status": for opProxy, its 1Password authorization. */
export interface ProviderStatus {
  ok: boolean
  /** What it is about ("1Password"). */
  label: string
  /** When it became ok, or stopped being ok. */
  since: number
  /** Only while ok, if known: when it runs out at the latest. */
  until?: number
  /** Only while not ok: the notification's headline and the line under it. */
  title?: string
  detail?: string
}

/** A request waiting for an answer. Fields as APPROVAL_FEED.md's Item, plus its source. */
export interface ApprovalItem {
  source: string
  id: string
  revision: number
  createdAt: number
  /** When it times out; null while the provider is not yet counting down. */
  expiresAt: number | null
  challenge: string
  /** A JSON document, as the provider's string. Parse it to show it; never re-encode it. */
  document: string
}

/** A request that stopped waiting a moment ago, so a phone showing it can say why it went. */
export interface ClosedApproval {
  source: string
  id: string
  /** The provider's word on it, e.g. "Approved on the Mac". */
  note?: string
  at: number
}

export interface ApprovalsSnapshot {
  sources: ApprovalSource[]
  items: ApprovalItem[]
  closed: ClosedApproval[]
}

/** A reply as the phone's native code signs it (APPROVAL_FEED.md, "The signed statement"). */
export interface SignedApprovalReply {
  keyId: string
  /** The exact string that was signed. */
  statement: string
  /** Base64 DER ECDSA P-256 signature over the statement's UTF-8 bytes. */
  signature: string
}

export interface ApprovalOutcome {
  ok: boolean
  error?: string
}

// ─── The document, as the phone renders it ─────────────────────────────────

export type ApprovalTone = 'info' | 'caution' | 'danger'

export interface ApprovalFieldRow { label: string; value: string; mono?: boolean }

export type ApprovalSection =
  | { kind: 'fields'; label?: string; rows: ApprovalFieldRow[] }
  | { kind: 'text'; label?: string; text: string; mono?: boolean }
  /** A kind this client does not know: shown by its label and text, if it has them. */
  | { kind: string; label?: string; text?: string }

export interface ApprovalPickerOption { id: string; label: string; hint?: string }

export interface ApprovalPicker {
  id: string
  label: string
  default?: string
  options: ApprovalPickerOption[]
}

export interface ApprovalAction {
  id: string
  label: string
  /** `approve` is signed only after the native slide control; anything else at a tap. */
  role: 'approve' | 'deny' | 'neutral' | string
}

export interface ApprovalDocument {
  tone?: ApprovalTone | string
  kicker?: string
  title: string
  subtitle?: string
  surfaceId?: string
  sections?: ApprovalSection[]
  notice?: string
  pickers?: ApprovalPicker[]
  actions: ApprovalAction[]
  confirm: string
}

/** The document, or null if it is not one this client can show. */
export function parseApprovalDocument(raw: string): ApprovalDocument | null {
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof doc !== 'object' || doc === null) return null
  const d = doc as Partial<ApprovalDocument>
  if (typeof d.title !== 'string' || typeof d.confirm !== 'string' || !Array.isArray(d.actions)) return null
  return d as ApprovalDocument
}

/** Each picker's default (or first) option: what the phone starts with. */
export function defaultPicks(doc: ApprovalDocument): Record<string, string> {
  const picks: Record<string, string> = {}
  for (const p of doc.pickers ?? []) {
    const id = p.default ?? p.options[0]?.id
    if (id !== undefined) picks[p.id] = id
  }
  return picks
}

/** The key that identifies an item across sources. */
export function approvalKey(item: { source: string; id: string }): string {
  return `${item.source}\u0000${item.id}`
}
