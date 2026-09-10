import * as fs from 'fs'
import { basename, join } from 'path'

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

/**
 * One plugin inside a marketplace.
 *
 * Skills only, deliberately. A plugin ships `plugin.json`, `commands/`,
 * `agents/`, `skills/`, `hooks/` and `.mcp.json` — `CLAUDE.md` is not part of
 * the plugin format. It is project or user memory, discovered from the working
 * directory hierarchy and `~/.claude`, so a `CLAUDE.md` sitting in a plugin
 * directory is a file Claude Code never reads. Showing a card for one would
 * advertise instructions that have no effect, which is worse than showing
 * nothing. Commands are out of scope on the same reasoning the feature started
 * with: a command is a skill with one extra line of frontmatter.
 */
export interface PluginScan {
  /** The name the manifest gives it — the caption, and the key prefix. */
  name: string
  dir: string
  skillsRoot: string | null
  skills: MetaDoc[]
}

export interface MarketplaceScan {
  /** The manifest's own name, or the directory's when it declares none. */
  name: string
  dir: string
  plugins: PluginScan[]
}

export interface MetaScan {
  /** `CLAUDE.md` documents, outermost first. */
  docs: MetaDoc[]
  /** Where skills were found, for the group's tooltip. Null when there are none. */
  skillsRoot: string | null
  skills: MetaDoc[]
  /**
   * A marketplace this directory hosts, if any.
   *
   * Additive, never a substitute. A repo can perfectly well have its own
   * `CLAUDE.md`, its own `.claude/skills`, AND publish a marketplace of plugins
   * that each have their own — an earlier version only looked for the
   * marketplace when the repo had no skills of its own, which made the two
   * mutually exclusive for no reason.
   */
  marketplace: MarketplaceScan | null
}

export type MetaHostKind = 'user' | 'project'

const EMPTY_SCAN: MetaScan = { docs: [], skillsRoot: null, skills: [], marketplace: null }

/** True when a scan found anything worth building a branch for. */
export function hasAgentMeta(scan: MetaScan): boolean {
  if (scan.docs.length > 0 || scan.skills.length > 0) return true
  return (scan.marketplace?.plugins ?? []).some((plugin) => plugin.skills.length > 0)
}

/** The key prefix a plugin's documents and skills carry, so nothing collides. */
export function pluginKeyPrefix(pluginName: string): string {
  return `plugin:${pluginName}/`
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

/**
 * The marketplace this directory publishes, with each local plugin scanned.
 *
 * Only relative sources describe a directory in this repo; a git or npm source
 * names something we have not fetched and cannot read.
 */
function scanMarketplace(hostDir: string, io: MetaScanIO): MarketplaceScan | null {
  const raw = io.readFile(join(hostDir, '.claude-plugin', 'marketplace.json'))
  if (raw === undefined) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // A manifest mid-edit is not an error worth surfacing on the canvas; it
    // just means no plugins this scan. The next watch event re-reads it.
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const manifest = parsed as { name?: unknown; plugins?: unknown }
  if (!Array.isArray(manifest.plugins)) return null

  const plugins: PluginScan[] = []
  for (const entry of manifest.plugins) {
    if (typeof entry !== 'object' || entry === null) continue
    const { name, source } = entry as { name?: unknown; source?: unknown }
    if (typeof name !== 'string' || typeof source !== 'string') continue
    if (!source.startsWith('.') && !source.startsWith('/')) continue

    const dir = join(hostDir, source)
    if (!io.isDirectory(dir)) continue

    const skillsRoot = join(dir, 'skills')
    const skills = skillsIn(skillsRoot, io, pluginKeyPrefix(name))
    if (skills.length === 0) continue
    plugins.push({ name, dir, skillsRoot, skills })
  }

  if (plugins.length === 0) return null
  return {
    name: typeof manifest.name === 'string' ? manifest.name : basename(hostDir),
    dir: hostDir,
    plugins
  }
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
    return { docs, skillsRoot: skills.length > 0 ? skillsRoot : null, skills, marketplace: null }
  }

  const docs: MetaDoc[] = []
  const topDoc = join(absHostDir, 'CLAUDE.md')
  if (io.isFile(topDoc)) docs.push({ key: 'CLAUDE.md', path: topDoc })

  // A plugin keeps its skills at `skills/`, with no `.claude` in the path.
  const isPlugin = io.isFile(join(absHostDir, '.claude-plugin', 'plugin.json'))
  const ownSkillsRoot = isPlugin ? join(absHostDir, 'skills') : join(absHostDir, '.claude', 'skills')

  // A second CLAUDE.md inside `.claude/` is a different document from the
  // top-level one, so both get a card. A plugin has no `.claude` to look in.
  if (!isPlugin) {
    const nestedDoc = join(absHostDir, '.claude', 'CLAUDE.md')
    if (io.isFile(nestedDoc)) docs.push({ key: '.claude/CLAUDE.md', path: nestedDoc })
  }

  const skills = skillsIn(ownSkillsRoot, io)

  return {
    docs,
    skillsRoot: skills.length > 0 ? ownSkillsRoot : null,
    skills,
    // Independent of everything above: a repo may publish a marketplace and
    // still have documents and skills of its own.
    marketplace: isPlugin ? null : scanMarketplace(absHostDir, io)
  }
}
