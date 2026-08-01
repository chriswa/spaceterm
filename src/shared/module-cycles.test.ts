import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

/**
 * Guards against circular imports between modules under `src/`.
 *
 * This exists because a cycle got through everything else. `node-size.ts`
 * re-exported a function from `card-types.ts`, which imports constants back
 * from `node-size.ts`. Typecheck passed — types erase, so a type-level cycle is
 * harmless — and lint passed, because `no-use-before-define` only sees within a
 * file. At runtime the cycle put `CELL_WIDTH` in its temporal dead zone while
 * `card-types` evaluated its module-level default sizes, and three unrelated
 * test files died with "Cannot access 'CELL_WIDTH' before initialization".
 *
 * A cycle is not always fatal — it only bites when one module needs a value
 * from the other during module evaluation rather than at call time — but it is
 * never intentional here, and "not fatal yet" is a bad thing to rely on.
 */

const SRC = path.join(__dirname, '..')

function sourceFiles(dir: string, out: string[] = []): string[] {
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
 * Relative specifiers that survive to runtime, in source order.
 *
 * Three kinds are deliberately excluded, because none of them can produce an
 * evaluation-order cycle:
 *  - `import type` / `export type`, which TypeScript erases entirely. The
 *    protocol.ts ↔ state.ts pair is one of these and is fine.
 *  - dynamic `import()`, which resolves after both modules have evaluated.
 *  - anything non-relative, which cannot be part of a cycle inside src/.
 */
export function relativeValueSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  // `import ... from '.'` / `export ... from '.'`, where the clause does not
  // begin with the `type` keyword.
  //
  // The clause pattern is `[^'"]*?` — newlines allowed, quotes not. A first
  // version used `[^'"\n]*?`, which silently skipped every multi-line import
  // and made the whole check vacuous: it passed against the exact cycle it was
  // written to catch. Quotes are the right boundary because an import clause
  // never contains one before its `from`, so the match cannot run past the end
  // of one statement into the next.
  const staticRe = /^[ \t]*(?:import|export)\s+(?!type\s)[^'"]*?from\s*['"](\.[^'"]*)['"]/gm
  // Bare `import '.'` for side effects — the strongest kind of value edge.
  const bareRe = /^[ \t]*import\s*['"](\.[^'"]*)['"]/gm
  for (const re of [staticRe, bareRe]) {
    let m: RegExpExecArray | null
    while ((m = re.exec(source)) !== null) specifiers.push(m[1])
  }
  return specifiers
}

/** Resolve a relative specifier to a file on disk, or null if it is not one. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
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

function buildGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>()
  for (const file of sourceFiles(SRC)) {
    const source = fs.readFileSync(file, 'utf-8')
    const edges: string[] = []
    for (const spec of relativeValueSpecifiers(source)) {
      const target = resolveSpecifier(file, spec)
      if (target && target !== file) edges.push(target)
    }
    graph.set(file, [...new Set(edges)])
  }
  return graph
}

/** Every cycle in the graph, each as a readable chain of repo-relative paths. */
function findCycles(graph: Map<string, string[]>): string[] {
  const cycles = new Set<string>()
  const onStack = new Set<string>()
  const done = new Set<string>()
  const stack: string[] = []
  const rel = (f: string): string => path.relative(path.join(SRC, '..'), f)

  function visit(node: string): void {
    if (done.has(node)) return
    if (onStack.has(node)) {
      const start = stack.indexOf(node)
      const chain = [...stack.slice(start), node].map(rel)
      // Normalise rotation so the same cycle is reported once.
      const key = [...chain.slice(0, -1)].sort().join('|')
      if (!cycles.has(key)) cycles.add(key)
      return
    }
    onStack.add(node)
    stack.push(node)
    for (const next of graph.get(node) ?? []) visit(next)
    stack.pop()
    onStack.delete(node)
    done.add(node)
  }

  for (const node of graph.keys()) visit(node)
  return [...cycles].map((k) => k.split('|').join(' → '))
}

describe('module graph', () => {
  it('has no circular imports', () => {
    const cycles = findCycles(buildGraph())
    expect(cycles, `circular import(s):\n  ${cycles.join('\n  ')}`).toEqual([])
  })
})

describe('the cycle detector itself', () => {
  // The detector is only worth having if it would actually have caught the bug,
  // so exercise it against a graph that reproduces the shape.
  function cyclesOf(edges: Record<string, string[]>): string[] {
    const graph = new Map(Object.entries(edges).map(([k, v]) => [k, v]))
    return findCycles(graph)
  }

  it('finds a two-module cycle — the shape node-size/card-types had', () => {
    expect(cyclesOf({ a: ['b'], b: ['a'] })).toHaveLength(1)
  })

  it('finds a longer cycle', () => {
    expect(cyclesOf({ a: ['b'], b: ['c'], c: ['a'] })).toHaveLength(1)
  })

  it('reports a cycle once, not once per entry point', () => {
    expect(cyclesOf({ entry1: ['a'], entry2: ['a'], a: ['b'], b: ['a'] })).toHaveLength(1)
  })

  it('does not flag a diamond, which is not a cycle', () => {
    expect(cyclesOf({ a: ['b', 'c'], b: ['d'], c: ['d'], d: [] })).toEqual([])
  })

  it('does not flag a plain chain', () => {
    expect(cyclesOf({ a: ['b'], b: ['c'], c: [] })).toEqual([])
  })
})

describe('the import scanner', () => {
  it('finds value imports, re-exports and side-effect imports', () => {
    const src = [
      `import { a } from './a'`,
      `export { c } from './c'`,
      `export * from './d'`,
      `import './side-effect'`
    ].join('\n')
    expect(relativeValueSpecifiers(src).sort()).toEqual(
      ['./a', './c', './d', './side-effect'].sort()
    )
  })

  it('finds a multi-line import', () => {
    // The first version of this scanner forbade newlines in the clause, so it
    // missed every import written this way — including the one that closed the
    // node-size/card-types cycle. It reported a clean graph against the exact
    // bug it exists to catch.
    const src = [
      'import {',
      '  DIRECTORY_HEIGHT,',
      '  FILE_WIDTH',
      `} from './node-size'`
    ].join('\n')
    expect(relativeValueSpecifiers(src)).toEqual(['./node-size'])
  })

  it('does not run one import into the next', () => {
    const src = [
      `import { a } from './a'`,
      `const label = 'not an import'`,
      `import { b } from './b'`
    ].join('\n')
    expect(relativeValueSpecifiers(src).sort()).toEqual(['./a', './b'])
  })

  it('ignores type-only imports and exports, which erase', () => {
    // This is the distinction that matters: protocol.ts and state.ts import
    // types from each other, and that cycle cannot fail at runtime.
    const src = [
      `import type { B } from './b'`,
      `export type { C } from './c'`
    ].join('\n')
    expect(relativeValueSpecifiers(src)).toEqual([])
  })

  it('still counts a re-export of a value — the edge that broke node-size', () => {
    expect(relativeValueSpecifiers(`export { measureCard as nodePixelSize } from './card-types'`))
      .toEqual(['./card-types'])
  })

  it('ignores package imports', () => {
    const src = `import * as fs from 'fs'\nimport { z } from 'zod'`
    expect(relativeValueSpecifiers(src)).toEqual([])
  })

  it('ignores dynamic imports, which resolve after both modules have evaluated', () => {
    expect(relativeValueSpecifiers(`const m = await import('./lazy')`)).toEqual([])
  })
})
