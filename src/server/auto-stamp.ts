import type { NodeId } from '../shared/ids'
import type { AutoStamp, NodeData } from '../shared/state'

/**
 * Auto-stamps: an icon generated from a node's title, so a canvas of
 * terminals can be told apart at a glance.
 *
 * Sonnet draws each icon through claude-print-daemon. A regeneration asks for
 * something different and shows the model what it drew before as its own
 * one-sentence descriptions, never the SVGs, which keeps the request small and
 * stops it iterating on a shape it already committed to.
 *
 * Every terminal surface gets one while generation is turned on.
 */

/** How long a title has to hold still before it is drawn. Agent titles churn while a turn starts. */
const TITLE_SETTLE_MS = 5_000
/** Longer than any icon should take; the daemon's own turn limit is longer still. */
const GENERATION_TIMEOUT_MS = 180_000
const MAX_SVG_CHARS = 20_000
/**
 * Icons drawn at once. A first start, or turning generation back on, finds
 * every surface wanting one, and each drawing is a claude process.
 */
const MAX_CONCURRENT = 2

export interface AutoStampReply {
  /** The model's reply text. */
  text: string
  costUsd: number
  claudeSessionId: string
}

export interface AutoStamperDeps {
  /** Ask Sonnet. Rejects on failure. */
  ask(prompt: string, signal: AbortSignal): Promise<AutoStampReply>
  getNode(nodeId: NodeId): NodeData | undefined
  /** Every live node, for the startup sweep. */
  getNodes(): NodeData[]
  /** The shared on/off setting. Off means nothing new is drawn. */
  isEnabled(): boolean
  setAutoStamp(nodeId: NodeId, autoStamp: AutoStamp): void
  /** Run `fn` after `ms`. Returns a cancel function. */
  schedule(fn: () => void, ms: number): () => void
  log(message: string): void
}

/** The title an icon depicts: what the node's title bar shows. */
export function autoStampTitle(node: NodeData): string | null {
  const raw = node.name?.trim() || (node.type === 'terminal' ? node.shellTitleHistory[0] : undefined)
  // Agent CLIs prefix their terminal title with a spinner or status glyph.
  const title = raw?.replace(/^[^\p{L}\p{N}]+/u, '').trim()
  return title || null
}

export function autoStampPrompt(title: string, previousDescriptions: readonly string[]): string {
  const parts = [
    `Draw a small icon for a terminal on a canvas of many terminals, so its owner can recognise it at a glance. The terminal's title is:

<title>${title}</title>

Pick one concrete object or symbol that stands for what the title is about, and draw it as an SVG:
- A monochrome silhouette: solid filled shapes in a single colour (#000). No outlines-only line art, no gradients, no other colours, no text or letters.
- viewBox="0 0 100 100", no width or height attributes.
- It must read clearly at 40 pixels: a bold, simple shape with few details.
- No scripts, styles, images, filters or links.

Reply in exactly this format and nothing else:
<description>One sentence saying what you drew and why it fits the title.</description>
<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">...</svg>`,
  ]
  if (previousDescriptions.length) {
    const list = previousDescriptions.map(d => `- ${d}`).join('\n')
    parts.push(`You have drawn icons for this terminal before:\n<previous_icons>\n${list}\n</previous_icons>`)
    parts.push('No, something different. Choose a different object or metaphor from every previous icon.')
  }
  return parts.join('\n\n')
}

/** The description and SVG out of a reply, or why the reply is unusable. */
export function parseAutoStampReply(text: string): { description: string; svg: string } | { error: string } {
  const description = text.match(/<description>([\s\S]*?)<\/description>/)?.[1].trim()
  const svg = text.match(/<svg[\s\S]*<\/svg>/)?.[0]
  if (!svg) return { error: 'reply contained no <svg>' }
  if (svg.length > MAX_SVG_CHARS) return { error: `SVG is ${svg.length} characters, over the ${MAX_SVG_CHARS} limit` }
  return { description: description || 'An icon.', svg }
}

export class AutoStamper {
  /** Pending settle timers, by node. */
  private readonly settling = new Map<NodeId, () => void>()
  /** In-flight generations, by node. */
  private readonly running = new Map<NodeId, AbortController>()
  /** Nodes whose title changed while a generation was running. */
  private readonly rerun = new Set<NodeId>()
  /** Generations waiting for a free slot, in order; the value is whether to ask for something different. */
  private readonly waiting = new Map<NodeId, boolean>()

  constructor(private readonly deps: AutoStamperDeps) {}

  private eligible(node: NodeData | undefined): node is NodeData {
    return node?.type === 'terminal' && !node.ephemeral && this.deps.isEnabled()
  }

  /**
   * Call whenever a node's name or shell title may have changed. Schedules an
   * icon for the new title once it has settled, if the node doesn't already
   * have one for it.
   */
  titleMaybeChanged(nodeId: NodeId): void {
    const node = this.deps.getNode(nodeId)
    if (!this.eligible(node)) return
    const title = autoStampTitle(node)
    if (!title || node.autoStamp?.title === title) return
    this.settling.get(nodeId)?.()
    this.settling.set(nodeId, this.deps.schedule(() => {
      this.settling.delete(nodeId)
      this.generate(nodeId, false)
    }, TITLE_SETTLE_MS))
  }

  /** A different icon for the node's current title, starting now. */
  regenerate(nodeId: NodeId): void {
    if (!this.eligible(this.deps.getNode(nodeId))) return
    this.settling.get(nodeId)?.()
    this.settling.delete(nodeId)
    this.generate(nodeId, true)
  }

  /**
   * Draw every icon that is missing, stale, or was left half-drawn by a
   * previous server. Called at startup and when generation is turned on.
   */
  resume(): void {
    for (const node of this.deps.getNodes()) {
      if (!this.eligible(node)) continue
      if (node.autoStamp?.status === 'generating' && !this.running.has(node.id)) this.generate(node.id, false)
      else this.titleMaybeChanged(node.id)
    }
  }

  dispose(): void {
    this.waiting.clear()
    for (const cancel of this.settling.values()) cancel()
    for (const controller of this.running.values()) controller.abort()
  }

  private generate(nodeId: NodeId, different: boolean): void {
    if (this.running.has(nodeId)) {
      // One generation per node; the newest title is picked up when it ends.
      this.rerun.add(nodeId)
      return
    }
    if (this.running.size >= MAX_CONCURRENT) {
      // A click outranks a title change waiting for the same node.
      this.waiting.set(nodeId, different || (this.waiting.get(nodeId) ?? false))
      return
    }
    this.waiting.delete(nodeId)
    const node = this.deps.getNode(nodeId)
    if (!this.eligible(node)) return
    const title = autoStampTitle(node)
    if (!title) return
    const prev = node.autoStamp
    // Earlier icons only matter to a request for something different. A new
    // title starts the list again: those icons were for a different subject.
    const sameTitle = prev?.title === title
    const previousDescriptions = sameTitle ? prev.previousDescriptions : []
    const base: AutoStamp = {
      title,
      status: 'generating',
      // Keep showing the old icon while its replacement is drawn.
      svg: prev?.svg,
      description: prev?.description,
      previousDescriptions,
      costUsd: prev?.costUsd ?? 0,
    }
    this.deps.setAutoStamp(nodeId, base)
    const prompt = autoStampPrompt(title, different && sameTitle ? previousDescriptions : [])
    const controller = new AbortController()
    this.running.set(nodeId, controller)
    const tag = nodeId.slice(0, 8)
    this.deps.log(`[auto-stamp] ${tag} drawing "${title}"${different ? ` (attempt ${previousDescriptions.length + 1}, something different)` : ''}`)

    void this.deps.ask(prompt, AbortSignal.any([controller.signal, AbortSignal.timeout(GENERATION_TIMEOUT_MS)]))
      .then((reply) => {
        const costUsd = base.costUsd + reply.costUsd
        const parsed = parseAutoStampReply(reply.text)
        if ('error' in parsed) {
          this.deps.log(`[auto-stamp] ${tag} unusable reply from claude-print-daemon session ${reply.claudeSessionId}: ${parsed.error}`)
          this.deps.setAutoStamp(nodeId, { ...base, status: 'failed', error: parsed.error, costUsd })
          return
        }
        this.deps.log(`[auto-stamp] ${tag} drew "${parsed.description}" ($${reply.costUsd.toFixed(4)}, session ${reply.claudeSessionId})`)
        this.deps.setAutoStamp(nodeId, {
          title, status: 'ready', svg: parsed.svg, description: parsed.description,
          previousDescriptions: [...previousDescriptions, parsed.description], costUsd,
        })
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        const error = err instanceof Error ? err.message : String(err)
        this.deps.log(`[auto-stamp] ${tag} failed: ${error}`)
        this.deps.setAutoStamp(nodeId, { ...base, status: 'failed', error })
      })
      .finally(() => {
        this.running.delete(nodeId)
        if (this.rerun.delete(nodeId)) this.titleMaybeChanged(nodeId)
        const next = this.waiting.entries().next()
        if (!next.done) {
          const [waitingId, waitingDifferent] = next.value
          this.waiting.delete(waitingId)
          this.generate(waitingId, waitingDifferent)
        }
      })
  }
}
