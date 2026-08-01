import * as fs from 'fs'
import * as path from 'path'

/**
 * Reading the import graph out of source, without a bundler.
 *
 * Two structural invariants are checked against this graph and neither is
 * visible to typecheck or lint: that no import cycle exists
 * (`module-cycles.test.ts`), and that nothing the renderer reaches pulls in a
 * Node builtin (`renderer-purity.test.ts`).
 *
 * Both need the same "which imports survive to runtime" question answered the
 * same way, and that answer is the part that was subtly wrong once — the first
 * cycle detector's regex skipped every multi-line import, which made it pass
 * against the exact cycle it was written to catch. One implementation, so a fix
 * lands for both.
 *
 * Testing-only. Nothing under `src/` imports this outside a `.test.ts`.
 */

/** Repo `src/` directory. */
export const SRC_ROOT = path.join(__dirname, '..', '..')

/** Every `.ts`/`.tsx` file under `dir`, recursively. */
export function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'assets') continue
      sourceFiles(full, out)
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

/**
 * Every import specifier that survives to runtime as a value edge, relative and
 * bare alike, in source order.
 *
 * Three kinds are deliberately excluded, because none reaches the runtime graph:
 *  - `import type` / `export type`, which TypeScript erases entirely.
 *  - dynamic `import()`, which resolves after both modules have evaluated.
 *  - re-exports of types only.
 *
 * The clause pattern is `[^'"]*?` — newlines allowed, quotes not. A first
 * version used `[^'"\n]*?`, which silently skipped every multi-line import and
 * made the whole check vacuous. Quotes are the right boundary because an import
 * clause never contains one before its `from`, so a match cannot run past the
 * end of one statement into the next.
 */
export function valueSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  const staticRe = /^[ \t]*(?:import|export)\s+(?!type\s)[^'"]*?from\s*['"]([^'"]+)['"]/gm
  // Bare `import 'x'` for side effects — the strongest kind of value edge.
  const bareRe = /^[ \t]*import\s*['"]([^'"]+)['"]/gm
  for (const re of [staticRe, bareRe]) {
    let m: RegExpExecArray | null
    while ((m = re.exec(source)) !== null) specifiers.push(m[1])
  }
  return specifiers
}

/** Just the relative ones — the only specifiers that can form a cycle inside `src/`. */
export function relativeValueSpecifiers(source: string): string[] {
  return valueSpecifiers(source).filter((s) => s.startsWith('.'))
}

/** Resolve a relative specifier to a file on disk, or null if it is not one. */
export function resolveSpecifier(fromFile: string, specifier: string): string | null {
  // Written as '.js' in ESM-style imports, but the file on disk is '.ts'.
  const base = path.resolve(path.dirname(fromFile), specifier.replace(/\.js$/, ''))
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx')
  ]
  return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) ?? null
}

/** A module and the runtime-relevant imports reachable from it. */
export interface ModuleImports {
  /** Resolved paths of local modules this one imports for their values. */
  local: string[]
  /** Bare specifiers — npm packages and Node builtins. */
  bare: string[]
}

export function importsOf(file: string): ModuleImports {
  const source = fs.readFileSync(file, 'utf-8')
  const local: string[] = []
  const bare: string[] = []
  for (const spec of valueSpecifiers(source)) {
    if (!spec.startsWith('.')) {
      bare.push(spec)
      continue
    }
    const target = resolveSpecifier(file, spec)
    if (target && target !== file) local.push(target)
  }
  return { local: [...new Set(local)], bare: [...new Set(bare)] }
}

/**
 * Every module reachable from `entries` by following value imports.
 *
 * This is the set a bundler would actually include, which is what makes it the
 * right set to ask environment questions about — "does anything the renderer
 * loads need `fs`" is a question about reachability, not about which directory
 * a file happens to live in.
 */
export function reachableFrom(entries: string[]): Map<string, ModuleImports> {
  const seen = new Map<string, ModuleImports>()
  const queue = [...entries]
  while (queue.length > 0) {
    const file = queue.shift()!
    if (seen.has(file)) continue
    const imports = importsOf(file)
    seen.set(file, imports)
    queue.push(...imports.local)
  }
  return seen
}

/** Path relative to the repo root, for readable assertion messages. */
export function repoRelative(file: string): string {
  return path.relative(path.join(SRC_ROOT, '..'), file)
}
