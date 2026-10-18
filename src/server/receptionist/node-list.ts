import type { NodeId } from '../../shared/ids'
import { ROOT_NODE_ID } from '../../shared/ids'
import { nodeLabelText } from '../../shared/node-label'
import type { DirectoryNodeData, NodeData, TitleNodeData } from '../../shared/state'
import { getAncestorCwd } from '../path-utils'

/**
 * The list_nodes tool: the canvas as Control is shown it, a line per node.
 *
 * Nodes are not unique by name. A title and a directory can both be called
 * goxcraft, and two titles can both say Fleet; often only the chain of
 * ancestors tells them apart. So every line carries the node's whole path from
 * the top of the canvas, and its handle, which is the one thing that is always
 * unique. Handles come from the caller, built over every live node whatever
 * the filter, so a node has the same handle in every list, in nearby, and in
 * any tool that takes one.
 *
 * A note can hold pages, and is only ever shown by its first line, cut short:
 * every result stays in Control's session until compaction.
 */

/** What list_nodes is asked to show, as the model writes it. */
export const NODE_LIST_SHOWS = ['directories', 'titles', 'directories and titles', 'everything'] as const
export type NodeListShow = typeof NODE_LIST_SHOWS[number]
export const DEFAULT_NODE_LIST_SHOW: NodeListShow = 'directories and titles'

/** The most of a note's first line a list shows. */
export const NOTE_CHARS = 128
/** The most of a note's first line a path shows: a path names it, it does not quote it. */
const PATH_NOTE_CHARS = 40
/**
 * The longest list returned; past it, the rest is counted, not shown. A
 * guard, not a page: if lists come near it, the tool needs rethinking.
 */
export const NODE_LIST_CHARS = 12_000

/** What the default list shows: the directories and titles, which the canvas is organised by. */
function isPlace(node: NodeData): node is DirectoryNodeData | TitleNodeData {
  return node.type === 'directory' || node.type === 'title'
}

export interface NodeListContext {
  /** The root's default working directory, which a title with no directory above it hands on. */
  rootCwd?: string
  /** A node's handle, such as `node-amber-otter`. */
  handleOf(nodeId: NodeId): string
  /** A live agent's token, such as `{Kevin:amber-otter}`; undefined for any other node. */
  agentTokenOf(nodeId: NodeId): string | undefined
}

export interface NodeList {
  text: string
  /** How many nodes the filter matched. */
  matched: number
  /** How many of those the size cap left out. */
  omitted: number
}

/**
 * The nodes `show` asks for, in tree order so that siblings sit together, each
 * with its path. Generated nodes (the agent docs branch) are left out: they
 * mirror files on disk, and nothing can be started under them.
 */
export function renderNodeList(nodes: readonly NodeData[], show: NodeListShow, context: NodeListContext): NodeList {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const record = Object.fromEntries(byId)
  const lines: string[] = []
  let matched = 0
  let omitted = 0
  let chars = 0
  for (const node of treeOrder(nodes, byId)) {
    if (!shows(show, node)) continue
    matched++
    const line = lineFor(node, byId, record, context)
    if (chars + line.length + 1 > NODE_LIST_CHARS) {
      omitted++
      continue
    }
    lines.push(line)
    chars += line.length + 1
  }
  if (!matched) return { text: `No ${show === 'everything' ? 'nodes' : show} are on the canvas.`, matched, omitted }
  if (omitted) {
    lines.push(`…and ${omitted} more, left out because the list is too long.${show === 'everything' ? ' Ask for directories or titles alone to see fewer at once.' : ''}`)
  }
  return { text: lines.join('\n'), matched, omitted }
}

/**
 * Where a node sits, outermost first: `directory ~/goxcraft > title "Fleet"`.
 * Empty for a node at the top of the canvas.
 */
export function pathWords(nodeId: NodeId, byId: ReadonlyMap<NodeId, NodeData>, context: NodeListContext): string {
  const chain: string[] = []
  const seen = new Set<NodeId>([nodeId])
  let parentId = byId.get(nodeId)?.parentId
  while (parentId && parentId !== ROOT_NODE_ID && !seen.has(parentId)) {
    seen.add(parentId)
    const parent = byId.get(parentId)
    if (!parent) break
    chain.unshift(describeNode(parent, context))
    parentId = parent.parentId
  }
  return chain.join(' > ')
}

/** A node generated from files on disk (the agent docs branch): never listed, and nothing can go under it. */
export function isGenerated(node: NodeData): boolean {
  return !!node.ephemeral || node.type === 'meta-group' || node.type === 'meta-doc'
}

/** A node as a path or a result names it: `title "Fleet"`, `{Kevin:amber-otter} agent "water sim"`. */
export function describeNode(node: NodeData, context: NodeListContext): string {
  return nodeWords(node, context, PATH_NOTE_CHARS)
}

function shows(show: NodeListShow, node: NodeData): boolean {
  if (isGenerated(node)) return false
  switch (show) {
    case 'directories': return node.type === 'directory'
    case 'titles': return node.type === 'title'
    case 'directories and titles': return isPlace(node)
    case 'everything': return true
  }
}

function lineFor(node: NodeData, byId: ReadonlyMap<NodeId, NodeData>, record: Record<string, NodeData>, context: NodeListContext): string {
  // An agent is named by its token, which nodeWords leads with; anything else by its handle.
  const handle = context.agentTokenOf(node.id) ? '' : `[${context.handleOf(node.id)}] `
  const fields = [`${handle}${nodeWords(node, context, NOTE_CHARS)}`]
  const path = pathWords(node.id, byId, context)
  fields.push(path ? `under: ${path}` : 'at the top level')
  if (node.type === 'title') {
    const cwd = getAncestorCwd(record, node.id, context.rootCwd)
    fields.push(cwd ? `agents started here run in ${cwd}` : 'agents started here have no directory to run in')
  }
  return fields.join(' | ')
}

/** A node in a few words: what it is, and what it is called or says. */
function nodeWords(node: NodeData, context: NodeListContext, noteChars: number): string {
  switch (node.type) {
    case 'directory': return `directory ${node.cwd}`
    case 'title': return `title "${flat(node.text)}"`
    case 'file': return `file ${node.filePath}`
    case 'markdown': {
      // A file-backed note's text is on disk, under the file node above it.
      if (node.fileBacked) return 'note showing the file above it'
      const firstLine = node.content.split('\n').find(line => line.trim())
      return firstLine ? `note "${clip(flat(firstLine), noteChars)}"` : 'empty note'
    }
    case 'terminal': {
      const token = context.agentTokenOf(node.id)
      const label = nodeLabelText(node)
      return token ? `${token} agent${label ? ` "${flat(label)}"` : ''}` : `terminal${label ? ` "${flat(label)}"` : ''}`
    }
    default: return node.type
  }
}

/** Live nodes from the top down, each followed by everything under it. A node whose parent is gone counts as at the top. */
function treeOrder(nodes: readonly NodeData[], byId: ReadonlyMap<NodeId, NodeData>): NodeData[] {
  const children = new Map<NodeId, NodeData[]>()
  for (const node of nodes) {
    const parent = byId.has(node.parentId) ? node.parentId : ROOT_NODE_ID
    children.set(parent, [...(children.get(parent) ?? []), node])
  }
  const order: NodeData[] = []
  const seen = new Set<NodeId>()
  const visit = (parentId: NodeId): void => {
    for (const child of children.get(parentId) ?? []) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      order.push(child)
      visit(child.id)
    }
  }
  visit(ROOT_NODE_ID)
  return order
}

function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function clip(text: string, chars: number): string {
  return text.length <= chars ? text : `${text.slice(0, chars - 1)}…`
}
