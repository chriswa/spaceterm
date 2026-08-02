/**
 * What a mod declares about itself, and what that buys it.
 *
 * ## Why capabilities, given this is explicitly not security
 *
 * A mod runs as the user, on their machine, with their files. Nothing here
 * stops a determined mod doing anything the user could do, and MODDING.md says
 * so under *Security*. Capabilities are for **blast radius and legibility**:
 *
 * - A mod that never declared `fork-claude` cannot fork a session *by
 *   accident* — through a bug, a stale message, or a copied example.
 * - The manifest is a readable answer to "what does this thing do to my
 *   canvas", which is the question a user actually has before installing one.
 * - `spaceterm-cli mods` can list who asked for what, which is the ecosystem
 *   tooling the plan calls the highest-leverage item.
 *
 * Treating it as a sandbox would be a lie. Treating it as a declaration is
 * useful and honest.
 */

/**
 * Every capability a mod can ask for. One per thing `ScriptHost` lets a mod do
 * to spaceterm, grouped so the list stays readable rather than mirroring the
 * method names one-to-one.
 */
export const MOD_CAPABILITIES = [
  /** Read the node tree: a node, a session's node, the nearest terminal ancestor. */
  'read-nodes',
  /** Locate a terminal's newest Claude transcript on disk. */
  'read-transcript',
  /** Type into a live terminal, with or without submitting. */
  'write-terminal',
  /** Mark a surface unread, which drives the toolbar's attention state. */
  'mark-unread',
  /** Fork a terminal's Claude session into a new surface. */
  'fork-session',
  /** Send this mod's own envelopes to the rest of the app. */
  'emit-mod',
  /** Receive spaceterm's event stream. */
  'subscribe-events',
] as const

/** A capability the base defines. Bare id, fixed list, enforced on the socket. */
export type BaseModCapability = (typeof MOD_CAPABILITIES)[number]

/**
 * A capability *a mod* defines, namespaced to it: `summary-chat:speak`.
 *
 * The base validates the shape and nothing else. It cannot know what such a
 * capability means, whether the provider is installed, or whether it is
 * honoured — which is exactly the arrangement facets and themes already use,
 * and for the same reason.
 */
export type ModProvidedCapability = `${string}:${string}`

export type ModCapability = BaseModCapability | ModProvidedCapability

const CAPABILITY_SET: ReadonlySet<string> = new Set(MOD_CAPABILITIES)

export function isBaseModCapability(value: string): value is BaseModCapability {
  return CAPABILITY_SET.has(value)
}

/** Well-formed `<modId>:<name>`, both halves non-empty. */
export function isModProvidedCapability(value: string): value is ModProvidedCapability {
  const parts = value.split(':')
  return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0
}

export function isModCapability(value: string): value is ModCapability {
  return isBaseModCapability(value) || isModProvidedCapability(value)
}

export interface ModManifest {
  /**
   * Stable identifier, and the namespace for everything this mod registers —
   * facet ids, theme ids, envelope `modId`. Lowercase, no colon, since the
   * colon is the namespace separator.
   */
  id: string
  /** Human name for the mod list. */
  name: string
  version: string
  /** The scripts-socket protocol version this mod was written against. */
  protocolVersion: number
  /**
   * What it may do. A base capability is refused on the scripts socket if it
   * is not listed here; a mod-provided one is only as binding as the mod that
   * defined it chooses to make it (see below).
   */
  capabilities: ModCapability[]
  /**
   * Capabilities this mod *defines*, for other mods to request. Must be
   * namespaced to this mod's id.
   *
   * The base records who provides what and reports a capability nobody
   * provides — it cannot enforce one. In-process there is no door: a mod can
   * import another mod directly and the base never sees it. What this buys is
   * that a mod handing out an API through the host can ask whether its caller
   * declared the capability, and that `provides`/`capabilities` together make
   * the dependency legible before anything runs.
   */
  provides?: ModProvidedCapability[]
  /**
   * Mods this one knows how to cooperate with, and what it expects of them.
   *
   * Advisory on purpose. A missing peer is a diagnostic, not a load failure,
   * because a mod that degrades gracefully without its peer is the behaviour
   * worth encouraging — and because the alternative is a dependency solver
   * nobody asked for.
   */
  peers?: Record<string, string>
  /** Argv for the out-of-process half. Omitted by a renderer-only mod. */
  command?: string[]
}

export interface ModManifestError {
  ok: false
  error: string
}

export interface ModManifestOk {
  ok: true
  manifest: ModManifest
}

const ID_PATTERN = /^[a-z][a-z0-9-]*$/

/**
 * Validate an untrusted manifest.
 *
 * Returns a reason rather than throwing: a bad manifest should disable one mod
 * with a legible complaint, not take down the server that was loading it.
 */
export function parseModManifest(value: unknown): ModManifestOk | ModManifestError {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, error: 'manifest must be an object' }
  }
  const raw = value as Record<string, unknown>

  const id = raw.id
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    return { ok: false, error: `id must match ${ID_PATTERN.source} (got ${JSON.stringify(id)})` }
  }

  const name = typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : id
  const version = typeof raw.version === 'string' ? raw.version : '0.0.0'

  if (typeof raw.protocolVersion !== 'number' || !Number.isInteger(raw.protocolVersion)) {
    return { ok: false, error: 'protocolVersion must be an integer' }
  }

  if (!Array.isArray(raw.capabilities)) {
    // Required rather than defaulted to empty: forgetting it and silently
    // getting a mod that can do nothing is a worse afternoon than being told.
    return { ok: false, error: 'capabilities must be an array (use [] for none)' }
  }
  const capabilities: ModCapability[] = []
  for (const entry of raw.capabilities) {
    if (typeof entry !== 'string' || !isModCapability(entry)) {
      // A namespaced capability is accepted without checking that anything
      // provides it: the provider may simply not be installed, and a manifest
      // should not become invalid because of what is missing beside it.
      return { ok: false, error: `unknown capability ${JSON.stringify(entry)}` }
    }
    if (!capabilities.includes(entry)) capabilities.push(entry)
  }

  let provides: ModProvidedCapability[] | undefined
  if (raw.provides !== undefined) {
    if (!Array.isArray(raw.provides)) {
      return { ok: false, error: 'provides must be an array' }
    }
    provides = []
    for (const entry of raw.provides) {
      if (typeof entry !== 'string' || !isModProvidedCapability(entry)) {
        return { ok: false, error: `provided capability ${JSON.stringify(entry)} must be <modId>:<name>` }
      }
      if (!entry.startsWith(`${id}:`)) {
        // Otherwise a mod could claim to provide another mod's capability and
        // quietly satisfy a dependency it has nothing to do with.
        return { ok: false, error: `provided capability "${entry}" must be namespaced to "${id}"` }
      }
      if (!provides.includes(entry)) provides.push(entry)
    }
  }

  let peers: Record<string, string> | undefined
  if (raw.peers !== undefined) {
    if (typeof raw.peers !== 'object' || raw.peers === null || Array.isArray(raw.peers)) {
      return { ok: false, error: 'peers must be an object of modId → version range' }
    }
    peers = {}
    for (const [peerId, range] of Object.entries(raw.peers as Record<string, unknown>)) {
      if (typeof range !== 'string') {
        return { ok: false, error: `peers.${peerId} must be a version range string` }
      }
      peers[peerId] = range
    }
  }

  let command: string[] | undefined
  if (raw.command !== undefined) {
    if (!Array.isArray(raw.command) || raw.command.some((a) => typeof a !== 'string')) {
      return { ok: false, error: 'command must be an array of strings' }
    }
    if (raw.command.length === 0) {
      return { ok: false, error: 'command must not be empty' }
    }
    command = raw.command as string[]
  }

  return {
    ok: true,
    manifest: {
      id, name, version,
      protocolVersion: raw.protocolVersion,
      capabilities,
      ...(provides ? { provides } : {}),
      ...(peers ? { peers } : {}),
      ...(command ? { command } : {}),
    },
  }
}
