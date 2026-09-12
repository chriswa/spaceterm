/**
 * Reading a process tree out of `ps` output and summing a subtree's memory.
 *
 * Split from `./agent-memory` for the same reason `ioreg-parse` is split from
 * `system-metrics`: that module spawns a process, this one is a string in and
 * a number out, so the interesting half is testable without a machine in a
 * particular state.
 */

export interface ProcessRow {
  pid: number
  ppid: number
  /** Resident set size in bytes. */
  rssBytes: number
}

/**
 * Parse the output of `ps -axo pid=,ppid=,rss=`.
 *
 * The `=` suffixes suppress the header, so every line is three integers.
 * macOS reports `rss` in kibibytes. Lines that do not parse are dropped rather
 * than throwing — a readout in the toolbar is not worth failing over one odd
 * row from a process that exited mid-listing.
 */
export function parsePsOutput(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 3) continue
    const pid = Number(parts[0])
    const ppid = Number(parts[1])
    const rssKib = Number(parts[2])
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(rssKib)) continue
    rows.push({ pid, ppid, rssBytes: rssKib * 1024 })
  }
  return rows
}

/**
 * Total RSS of every descendant of `rootPid`, excluding `rootPid` itself.
 *
 * RSS double-counts pages shared between processes, so this is an upper bound
 * rather than a true footprint — which is the right error for a "how much is
 * this costing me" readout to make.
 */
export function sumDescendantRss(rows: ProcessRow[], rootPid: number): number {
  const children = new Map<number, ProcessRow[]>()
  for (const row of rows) {
    const siblings = children.get(row.ppid)
    if (siblings) siblings.push(row)
    else children.set(row.ppid, [row])
  }

  // Breadth-first rather than recursive: a `ps` listing can contain a parent
  // cycle if a pid was reused between the rows being read, and a visited set
  // over an explicit queue cannot blow the stack on one.
  const seen = new Set<number>([rootPid])
  const queue = [rootPid]
  let total = 0
  while (queue.length > 0) {
    const pid = queue.pop() as number
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      total += child.rssBytes
      queue.push(child.pid)
    }
  }
  return total
}
