import { execFile } from 'child_process'
import { stat } from 'fs'
import { join, resolve as pathResolve } from 'path'
import { homedir } from 'os'
import type { GitStatus, DirectoryNodeData } from '../shared/state'

const POLL_INTERVAL_MS = 60_000
const EXEC_TIMEOUT_MS = 5_000

type GetDirectoryNodes = () => DirectoryNodeData[]
type OnGitStatus = (nodeId: string, gitStatus: GitStatus | null) => void

/**
 * Parse `git status --porcelain=v2 --branch` output into a GitStatus object.
 */
function parseGitStatus(stdout: string, fetchHeadMtime: number | null): GitStatus {
  let branch: string | null = null
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  let conflicts = 0
  let staged = 0
  let unstaged = 0
  let untracked = 0

  for (const line of stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const val = line.slice('# branch.head '.length)
      branch = val === '(detached)' ? null : val
    } else if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length)
    } else if (line.startsWith('# branch.ab ')) {
      const match = line.match(/\+(\d+) -(\d+)/)
      if (match) {
        ahead = parseInt(match[1], 10)
        behind = parseInt(match[2], 10)
      }
    } else if (line.startsWith('u ')) {
      // Unmerged (conflict) entry
      conflicts++
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      // Changed entry: "1 XY ..." or "2 XY ..."
      const xy = line.split(' ')[1]
      if (xy && xy.length >= 2) {
        const x = xy[0] // staged
        const y = xy[1] // unstaged
        if (x !== '.') staged++
        if (y !== '.') unstaged++
      }
    } else if (line.startsWith('? ')) {
      untracked++
    }
  }

  return {
    branch,
    upstream,
    ahead,
    behind,
    conflicts,
    staged,
    unstaged,
    untracked,
    lastFetchTimestamp: fetchHeadMtime,
  }
}

/**
 * Resolve a path that may start with `~`.
 */
function expandTilde(p: string): string {
  if (p.startsWith('~')) {
    return join(homedir(), p.slice(1))
  }
  return p
}

/**
 * Run `git status --porcelain=v2 --branch` in the given directory.
 * Returns null if the directory is not a git repo.
 */
function runGitStatus(cwd: string): Promise<GitStatus | null> {
  const resolvedCwd = expandTilde(cwd)
  return new Promise((resolve) => {
    execFile(
      'git',
      ['status', '--porcelain=v2', '--branch'],
      { cwd: resolvedCwd, timeout: EXEC_TIMEOUT_MS },
      (err, stdout) => {
        if (err) {
          // Not a git repo or git not available
          resolve(null)
          return
        }
        // Get FETCH_HEAD mtime via --git-common-dir (works for both normal repos and worktrees)
        execFile(
          'git',
          ['rev-parse', '--git-common-dir'],
          { cwd: resolvedCwd, timeout: EXEC_TIMEOUT_MS },
          (cdErr, cdStdout) => {
            if (cdErr) {
              resolve(parseGitStatus(stdout, null))
              return
            }
            const gitCommonDir = pathResolve(resolvedCwd, cdStdout.trim())
            stat(join(gitCommonDir, 'FETCH_HEAD'), (fhErr, fhStats) => {
              if (!fhErr && fhStats) {
                resolve(parseGitStatus(stdout, fhStats.mtimeMs))
              } else {
                resolve(parseGitStatus(stdout, null))
              }
            })
          }
        )
      }
    )
  })
}

export class GitStatusPoller {
  private timer: ReturnType<typeof setInterval> | null = null
  private cache = new Map<string, string>() // nodeId → JSON.stringify(GitStatus)
  private getDirectoryNodes: GetDirectoryNodes
  private onGitStatus: OnGitStatus

  constructor(getDirectoryNodes: GetDirectoryNodes, onGitStatus: OnGitStatus) {
    this.getDirectoryNodes = getDirectoryNodes
    this.onGitStatus = onGitStatus
    this.timer = setInterval(() => this.pollAll(), POLL_INTERVAL_MS)
    // Poll all directories immediately on startup
    this.pollAll()
  }

  removeNode(nodeId: string): void {
    this.cache.delete(nodeId)
  }

  /**
   * Immediately poll a specific node (e.g. after its cwd changes).
   * Invalidates the cache so the result always fires the callback.
   */
  pollNode(nodeId: string): void {
    const nodes = this.getDirectoryNodes()
    const node = nodes.find(n => n.id === nodeId)
    if (!node) return
    this.cache.delete(nodeId)
    runGitStatus(node.cwd).then((result) => {
      const json = JSON.stringify(result)
      this.cache.set(nodeId, json)
      this.onGitStatus(nodeId, result)
    }).catch(() => {
      // Ignore — will retry on next cycle
    })
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private pollAll(): void {
    const nodes = this.getDirectoryNodes()
    if (nodes.length === 0) return

    // Group node IDs by resolved cwd to deduplicate
    const cwdToNodeIds = new Map<string, string[]>()
    for (const node of nodes) {
      const resolved = expandTilde(node.cwd)
      const existing = cwdToNodeIds.get(resolved)
      if (existing) {
        existing.push(node.id)
      } else {
        cwdToNodeIds.set(resolved, [node.id])
      }
    }

    const uniqueCwds = [...cwdToNodeIds.entries()]
    // Spread checks evenly across the poll interval
    const spacing = uniqueCwds.length > 1
      ? POLL_INTERVAL_MS / uniqueCwds.length
      : 0

    for (let i = 0; i < uniqueCwds.length; i++) {
      const [cwd, nodeIds] = uniqueCwds[i]
      setTimeout(() => {
        runGitStatus(cwd).then((result) => {
          const json = JSON.stringify(result)
          for (const nodeId of nodeIds) {
            if (json !== this.cache.get(nodeId)) {
              this.cache.set(nodeId, json)
              this.onGitStatus(nodeId, result)
            }
          }
        }).catch(() => { /* retry next cycle */ })
      }, i * spacing)
    }
  }
}
