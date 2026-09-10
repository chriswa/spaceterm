import * as fs from 'fs'
import { join } from 'path'

/**
 * Finding the agent-facing documents that belong to a directory.
 *
 * Three layouts have to be recognised, because all three exist on this machine
 * and the user thinks of them as the same thing:
 *
 *  - **user**   `~/.claude` — `CLAUDE.md` and `skills/` sit directly inside.
 *  - **project** an ordinary repo — `CLAUDE.md` at the top, skills under
 *    `.claude/skills/`, and often a *second* `CLAUDE.md` inside `.claude/`.
 *  - **plugin**  a directory with `.claude-plugin/plugin.json` — skills live at
 *    `skills/`, with no `.claude` in the path at all. A **marketplace**
 *    (`.claude-plugin/marketplace.json`) is a directory of these, and is what
 *    `~/chriswa-devkit` actually is: the skills are one level down, in
 *    `default-plugin/`, so a scanner that only looked for `.claude/skills`
 *    would report the repo as having nothing.
 *
 * Pure over an injected filesystem, so the layout rules can be tested against a
 * literal tree rather than against whatever happens to be on the disk running
 * the suite.
 */

export interface MetaScanIO {
  isDirectory(path: string): boolean
  isFile(path: string): boolean
  readdir(path: string): string[]
  /** File contents, or undefined when unreadable. Only used for marketplace.json. */
  readFile(path: string): string | undefined
}

export const REAL_META_SCAN_IO: MetaScanIO = {
  isDirectory(path) {
    try {
      return fs.statSync(path).isDirectory()
    } catch {
      return false
    }
  },
  isFile(path) {
    try {
      return fs.statSync(path).isFile()
    } catch {
      return false
    }
  },
  readdir(path) {
    try {
      return fs.readdirSync(path)
    } catch {
      return []
    }
  },
  readFile(path) {
    try {
      return fs.readFileSync(path, 'utf-8')
    } catch {
      return undefined
    }
  }
}

/** One markdown document a card will be built for. */
export interface MetaDoc {
  /**
   * Stable identity within its group, and the caption the card falls back to.
   * A skill's directory name (`recall`), or a document's path relative to the
   * host (`CLAUDE.md`, `.claude/CLAUDE.md`). Stable across rescans is the
   * point: it is what lets a rescan leave an unchanged card exactly alone, and
   * what keys the remembered card positions.
   */
  key: string
  /** Absolute path to the file. */
  path: string
}

export interface MetaScan {
  /** `CLAUDE.md` documents, outermost first. */
  docs: MetaDoc[]
  /** Where skills were found, for the group's tooltip. Null when there are none. */
  skillsRoot: string | null
  skills: MetaDoc[]
}

export type MetaHostKind = 'user' | 'project'

const EMPTY_SCAN: MetaScan = { docs: [], skillsRoot: null, skills: [] }

/** True when a scan found anything worth building a branch for. */
export function hasAgentMeta(scan: MetaScan): boolean {
  return scan.docs.length > 0 || scan.skills.length > 0
}

/**
 * Every skill directly under one skills root: a subdirectory holding a
 * `SKILL.md`. Sorted, so the column a rescan lays out does not reshuffle.
 *
 * A subdirectory *without* a `SKILL.md` is not a skill and is skipped rather
 * than shown as an empty card — `references/` sits beside `SKILL.md` inside a
 * skill, and dotfiles turn up in any directory.
 */
function skillsIn(root: string, io: MetaScanIO, keyPrefix = ''): MetaDoc[] {
  if (!io.isDirectory(root)) return []
  const found: MetaDoc[] = []
  for (const entry of io.readdir(root).sort()) {
    if (entry.startsWith('.')) continue
    const skillMd = join(root, entry, 'SKILL.md')
    if (io.isFile(skillMd)) {
      found.push({ key: keyPrefix + entry, path: skillMd })
    }
  }
  return found
}

/** The plugin directories a marketplace manifest points at, relative paths resolved. */
function marketplacePlugins(hostDir: string, io: MetaScanIO): Array<{ name: string; dir: string }> {
  const raw = io.readFile(join(hostDir, '.claude-plugin', 'marketplace.json'))
  if (raw === undefined) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // A manifest mid-edit is not an error worth surfacing on the canvas; it
    // just means no plugins this scan. The next watch event re-reads it.
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const plugins = (parsed as { plugins?: unknown }).plugins
  if (!Array.isArray(plugins)) return []

  const result: Array<{ name: string; dir: string }> = []
  for (const entry of plugins) {
    if (typeof entry !== 'object' || entry === null) continue
    const { name, source } = entry as { name?: unknown; source?: unknown }
    if (typeof name !== 'string' || typeof source !== 'string') continue
    // Only relative sources describe a directory in this repo. A git or npm
    // source names something we have not fetched and cannot read.
    if (!source.startsWith('.') && !source.startsWith('/')) continue
    result.push({ name, dir: join(hostDir, source) })
  }
  return result
}

/**
 * Scan one host directory for the documents its agent reads.
 *
 * `absHostDir` must be absolute and `~`-expanded — directory nodes store their
 * cwd abbreviated (`abbreviateCwd`), so the caller resolves before calling.
 */
export function scanAgentMeta(absHostDir: string, kind: MetaHostKind, io: MetaScanIO): MetaScan {
  if (!io.isDirectory(absHostDir)) return EMPTY_SCAN

  if (kind === 'user') {
    // `~/.claude` itself: no nested `.claude`, no plugin manifest.
    const skillsRoot = join(absHostDir, 'skills')
    const skills = skillsIn(skillsRoot, io)
    const docs: MetaDoc[] = []
    const claudeMd = join(absHostDir, 'CLAUDE.md')
    if (io.isFile(claudeMd)) docs.push({ key: 'CLAUDE.md', path: claudeMd })
    return { docs, skillsRoot: skills.length > 0 ? skillsRoot : null, skills }
  }

  const docs: MetaDoc[] = []
  const topDoc = join(absHostDir, 'CLAUDE.md')
  if (io.isFile(topDoc)) docs.push({ key: 'CLAUDE.md', path: topDoc })

  const isPlugin = io.isFile(join(absHostDir, '.claude-plugin', 'plugin.json'))
  if (isPlugin) {
    const skillsRoot = join(absHostDir, 'skills')
    const skills = skillsIn(skillsRoot, io)
    return { docs, skillsRoot: skills.length > 0 ? skillsRoot : null, skills }
  }

  // An ordinary project. A second CLAUDE.md inside `.claude/` is common and is
  // a different document from the top-level one, so both get a card.
  const nestedDoc = join(absHostDir, '.claude', 'CLAUDE.md')
  if (io.isFile(nestedDoc)) docs.push({ key: '.claude/CLAUDE.md', path: nestedDoc })

  const projectSkillsRoot = join(absHostDir, '.claude', 'skills')
  const skills = skillsIn(projectSkillsRoot, io)
  if (skills.length > 0) {
    return { docs, skillsRoot: projectSkillsRoot, skills }
  }

  // No skills of its own — but it may be a marketplace whose plugins have them.
  // Keys are prefixed with the plugin name so two plugins can both ship a
  // `recall` without colliding in the position map.
  const plugins = marketplacePlugins(absHostDir, io)
  const fromPlugins: MetaDoc[] = []
  for (const plugin of plugins) {
    fromPlugins.push(...skillsIn(join(plugin.dir, 'skills'), io, `${plugin.name}/`))
  }
  if (fromPlugins.length > 0) {
    return { docs, skillsRoot: absHostDir, skills: fromPlugins }
  }

  return { docs, skillsRoot: null, skills: [] }
}
