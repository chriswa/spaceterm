import { spawn } from 'child_process'
import type { ArchivedNode, NodeData, TerminalNodeData } from '../shared/state'
import type { NodeId } from '../shared/ids'
import type { AgentSearchHit, AgentSearchMode, AgentSearchPass } from '../shared/protocol'
import { archivesOwnedBy, groupNodes } from '../shared/archive-tree'
import { readTranscript } from './summary-chat'

/**
 * Agent search: pick the agent surface a free-text query is about, with Jev
 * (TypeSafe System One) choosing among the surfaces as options of one Choice.
 *
 * Two passes. The first describes each surface by its title and directory
 * only, which is cheap. If no surface reaches {@link TITLE_PASS_THRESHOLD}, the
 * second asks again with the tail of each surface's transcript added. The
 * user can also ask for the second pass alone after the first stopped.
 */

/** Top probability the titles-only pass must reach to skip the transcript pass. */
export const TITLE_PASS_THRESHOLD = 0.75

/** How many archived agent surfaces are offered alongside the live ones. */
export const ARCHIVED_CANDIDATE_LIMIT = 20

/** Characters of transcript text kept per surface for the second pass. */
export const TRANSCRIPT_TAIL_CHARS = 500

const NONE_OPTION = 'none'

export interface AgentSearchCandidate {
  nodeId: NodeId
  title: string
  cwd?: string
  archived: boolean
  transcriptPath?: string
}

export interface AgentSearchOutcome {
  pass: AgentSearchPass
  /** Every candidate, most probable first. */
  hits: AgentSearchHit[]
  /** Probability Jev gave to "no surface matches". */
  noneProbability: number
  /** Summed over every pass that ran; null if Jev could not price a pass. */
  costUsd: number | null
}

/** A TypeSafe request body, as the `jev` CLI takes it on stdin. */
export interface JevRequest {
  state: unknown
  questions: Record<string, unknown>
}

/** The parts of a `jev` CLI response this module reads. */
export interface JevChoiceResponse {
  answers: Record<string, { probabilities: Record<string, number> }>
  _cost_estimate: number | null
}

export interface AgentSearchDeps {
  runJev(request: JevRequest): Promise<JevChoiceResponse>
  /** The last {@link TRANSCRIPT_TAIL_CHARS} of human/agent text, or '' if unreadable. */
  transcriptTail(path: string): string
}

export function isAgentSurface(data: NodeData): data is TerminalNodeData {
  return data.type === 'terminal' && (data.agentType !== undefined || data.claudeSessionHistory.length > 0)
}

/** Name first, then shell titles most recent first. */
export function agentSurfaceTitle(data: TerminalNodeData): string {
  const parts = [data.name, ...data.shellTitleHistory.slice(0, 3)].filter((p): p is string => !!p)
  return parts.join(' / ') || '(untitled)'
}

/**
 * Every live agent surface, plus the {@link ARCHIVED_CANDIDATE_LIMIT} most
 * recently archived ones. An agent surface swept into an archived subtree
 * counts as archived at the time its subtree was.
 */
export function collectAgentSurfaces(
  nodes: Record<string, NodeData>,
  rootArchivedChildren: ArchivedNode[],
): Array<{ data: TerminalNodeData; archived: boolean }> {
  const live = Object.values(nodes).filter(isAgentSurface)

  const archived = new Map<NodeId, { data: TerminalNodeData; archivedAt: string }>()
  const visit = (entries: ArchivedNode[]): void => {
    for (const entry of entries) {
      for (const member of groupNodes(entry)) {
        if (isAgentSurface(member) && !nodes[member.id] && !archived.has(member.id)) {
          archived.set(member.id, { data: member, archivedAt: entry.archivedAt })
        }
      }
      visit(archivesOwnedBy(entry))
    }
  }
  visit(rootArchivedChildren)
  for (const node of Object.values(nodes)) visit(node.archivedChildren ?? [])

  const recentArchived = [...archived.values()]
    .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt))
    .slice(0, ARCHIVED_CANDIDATE_LIMIT)

  return [
    ...live.map((data) => ({ data, archived: false })),
    ...recentArchived.map(({ data }) => ({ data, archived: true })),
  ]
}

function buildRequest(
  query: string,
  candidates: AgentSearchCandidate[],
  describe: (c: AgentSearchCandidate) => Record<string, string>,
): JevRequest {
  // Option keys are short indices: they are billed tokens, and a node id
  // carries no meaning the model can use.
  const criteria: Record<string, unknown> = {}
  candidates.forEach((c, i) => { criteria[`s${i}`] = describe(c) })
  criteria[NONE_OPTION] = 'No agent session matches what the user is looking for.'
  return {
    state: { user_query: query },
    questions: {
      target: {
        type: 'choice',
        instructions:
          'The user is searching for one of their coding-agent sessions. Which session is `user_query` looking for? ' +
          'Each option describes one session.',
        criteria,
      },
    },
  }
}

function readHits(
  response: JevChoiceResponse,
  candidates: AgentSearchCandidate[],
): { hits: AgentSearchHit[]; noneProbability: number } {
  const probabilities = response.answers.target?.probabilities
  if (!probabilities) throw new Error('Jev returned no answer for the search question')
  const hits = candidates
    .map((c, i) => ({ nodeId: c.nodeId, probability: probabilities[`s${i}`] ?? 0 }))
    .sort((a, b) => b.probability - a.probability)
  return { hits, noneProbability: probabilities[NONE_OPTION] ?? 0 }
}

function addCost(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a + b
}

export async function searchAgentSurfaces(
  query: string,
  candidates: AgentSearchCandidate[],
  deps: AgentSearchDeps,
  mode: AgentSearchMode = 'auto',
): Promise<AgentSearchOutcome> {
  if (candidates.length === 0) {
    return { pass: mode === 'auto' ? 'titles' : 'transcripts', hits: [], noneProbability: 1, costUsd: 0 }
  }

  let titleCost: number | null = 0
  if (mode === 'auto') {
    const titleResponse = await deps.runJev(buildRequest(query, candidates, (c) => ({
      title: c.title,
      directory: c.cwd ?? '',
    })))
    const titlePass = readHits(titleResponse, candidates)
    if ((titlePass.hits[0]?.probability ?? 0) >= TITLE_PASS_THRESHOLD) {
      return { pass: 'titles', ...titlePass, costUsd: titleResponse._cost_estimate }
    }
    titleCost = titleResponse._cost_estimate
  }

  const transcriptResponse = await deps.runJev(buildRequest(query, candidates, (c) => ({
    title: c.title,
    directory: c.cwd ?? '',
    recent_transcript: (c.transcriptPath && deps.transcriptTail(c.transcriptPath)) || '(no transcript available)',
  })))
  return {
    pass: 'transcripts',
    ...readHits(transcriptResponse, candidates),
    costUsd: addCost(titleCost, transcriptResponse._cost_estimate),
  }
}

export function transcriptTail(path: string): string {
  const text = readTranscript(path).map((m) => `${m.role}: ${m.text}`).join('\n')
  return text.slice(-TRANSCRIPT_TAIL_CHARS)
}

const JEV_TIMEOUT_MS = 60_000

/** Runs the `jev` CLI, which holds the API key lookup, retries, and pricing. */
export function jevCliRunner(env: () => NodeJS.ProcessEnv): AgentSearchDeps['runJev'] {
  return (request) => new Promise((resolve, reject) => {
    const child = spawn('jev', ['-'], { env: env(), timeout: JEV_TIMEOUT_MS })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (err) => reject(new Error(`could not run jev: ${err.message}`)))
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `jev exited with code ${code}`))
        return
      }
      try {
        resolve(JSON.parse(stdout) as JevChoiceResponse)
      } catch {
        reject(new Error('jev printed something other than JSON'))
      }
    })
    child.stdin.end(JSON.stringify(request))
  })
}
