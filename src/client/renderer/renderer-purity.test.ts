import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { reachableFrom, repoRelative, SRC_ROOT } from '../../shared/testing/module-graph'

/**
 * The renderer must stay loadable in a plain browser.
 *
 * It already is — it runs context-isolated with `nodeIntegration: false`, has no
 * `electron` import, no `ipcRenderer`, and touches exactly one Electron-specific
 * thing (`window.api`, the preload bridge). That is what makes it possible to
 * drive the real renderer in real Chromium with a faked bridge instead of
 * needing an Electron binary the CI container cannot download.
 *
 * But it is loadable *by accident*, not by construction. `src/shared/protocol.ts`
 * imports `path` and `os` at module scope, and the renderer imports that module
 * in five places — all of them `import type`, which TypeScript erases. Change
 * one of those to a value import and `node:path` enters the browser bundle. It
 * would still typecheck. It would still lint. It would still pass every test,
 * because nothing under `environment: 'node'` notices.
 *
 * So: walk the value-import graph from the renderer's entry point and assert
 * nothing reachable needs Node.
 */

const RENDERER_ENTRY = path.join(SRC_ROOT, 'client', 'renderer', 'src', 'main.tsx')

/**
 * Node builtins, with and without the `node:` prefix.
 *
 * Vite will not polyfill these; an import of one is a hard runtime failure in a
 * browser, not a degraded experience.
 */
const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 'fs/promises', 'http',
  'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks',
  'process', 'punycode', 'querystring', 'readline', 'repl', 'stream',
  'string_decoder', 'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm',
  'worker_threads', 'zlib'
])

function isNodeBuiltin(specifier: string): boolean {
  if (specifier.startsWith('node:')) return true
  return NODE_BUILTINS.has(specifier)
}

/** Packages that only exist inside Electron's main or preload process. */
const ELECTRON_ONLY = new Set(['electron', '@electron/rebuild', 'electron-vite'])

const graph = reachableFrom([RENDERER_ENTRY])

describe('the renderer bundle', () => {
  it('reaches a meaningful number of modules — a broken walk would pass vacuously', () => {
    // The guard below is only worth anything if the graph was actually built.
    // A resolver change that silently returned nothing would otherwise turn
    // every assertion here green.
    expect(graph.size).toBeGreaterThan(40)
  })

  it('starts from the entry point the HTML actually loads', () => {
    // index.html points at ./src/main.tsx; if that ever moves, this test would
    // be walking a graph nobody loads.
    expect(graph.has(RENDERER_ENTRY)).toBe(true)
  })

  it('imports no Node builtin, anywhere in its reachable graph', () => {
    const offenders: string[] = []
    for (const [file, imports] of graph) {
      for (const spec of imports.bare) {
        if (isNodeBuiltin(spec)) offenders.push(`${repoRelative(file)} imports '${spec}'`)
      }
    }
    expect(
      offenders,
      'A Node builtin reached the renderer bundle. This typechecks and lints ' +
      'cleanly but fails at runtime in a browser. The usual cause is an ' +
      '`import type` from src/shared/protocol.ts being changed to a value ' +
      `import:\n  ${offenders.join('\n  ')}`
    ).toEqual([])
  })

  it('imports nothing that only exists in the Electron main process', () => {
    const offenders: string[] = []
    for (const [file, imports] of graph) {
      for (const spec of imports.bare) {
        if (ELECTRON_ONLY.has(spec)) offenders.push(`${repoRelative(file)} imports '${spec}'`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('reaches src/shared/protocol.ts by type imports only', () => {
    // The specific invariant that keeps the renderer browser-loadable today.
    // Named explicitly so a failure says which file to look at rather than
    // just "something imports path".
    const protocolFile = path.join(SRC_ROOT, 'shared', 'protocol.ts')
    const importers = [...graph]
      .filter(([, imports]) => imports.local.includes(protocolFile))
      .map(([file]) => repoRelative(file))

    expect(
      importers,
      'src/shared/protocol.ts imports `path` and `os`, so the renderer may only ' +
      'reference it with `import type`. These files import it for a value:\n  ' +
      importers.join('\n  ')
    ).toEqual([])
  })
})

describe('the purity check itself', () => {
  // Same rule as the cycle detector: a structural guard is worth nothing until
  // you have watched it go red.
  it('recognises a builtin with and without the node: prefix', () => {
    expect(isNodeBuiltin('path')).toBe(true)
    expect(isNodeBuiltin('node:path')).toBe(true)
    expect(isNodeBuiltin('node:fs/promises')).toBe(true)
  })

  it('does not mistake an npm package for a builtin', () => {
    for (const pkg of ['react', 'zustand', '@xterm/xterm', 'path-browserify']) {
      expect(isNodeBuiltin(pkg), pkg).toBe(false)
    }
  })

  it('would catch the failure it exists to prevent', () => {
    // Walk from src/shared/protocol.ts itself — a module that DOES import
    // builtins — and confirm the same check reports it.
    const protocolGraph = reachableFrom([path.join(SRC_ROOT, 'shared', 'protocol.ts')])
    const found = [...protocolGraph].flatMap(([, imports]) => imports.bare).filter(isNodeBuiltin)
    expect(found.length).toBeGreaterThan(0)
  })
})
