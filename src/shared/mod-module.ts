/**
 * What a mod's code looks like, on either side.
 *
 * ## In-process, not spawned
 *
 * A mod supplies a module that spaceterm imports and calls — server code the
 * server calls, client code the renderer calls. There is no supervisor, no
 * health check, no restart policy, and no question about which process owns a
 * mod's lifetime: server code lives as long as the server, client code as long
 * as the renderer.
 *
 * The alternative considered was spawning each mod as a child process. It buys
 * crash isolation and costs a supervisor, and it makes instancing a problem —
 * one copy per window, since multiple Electron clients are a designed-for
 * case. Loading gets the right instancing for free. A mod that genuinely needs
 * a separate process (heavy CPU, another language) spawns one *itself*, from
 * its own server module, which is a thing it can already do and spaceterm need
 * not be involved in.
 *
 * What this gives up is stated plainly because it will bite eventually: an
 * unhandled throw in mod code can take down the process it runs in. The
 * loaders contain that as far as a `try`/`catch` can — a mod that throws
 * during `register` or `activate` is marked failed and the others carry on —
 * but a mod that blocks the event loop stops everything, and nothing short of
 * a process boundary would change that.
 *
 * ## Two phases, and why
 *
 * `register` runs for *every* mod before any mod's `activate`. It is for
 * declarations only — facets, themes, message routes — and must not start
 * timers, open sockets or read state. `activate` is where a mod actually does
 * something.
 *
 * The ordering is what lets one mod's theme restyle another mod's facet
 * without either knowing the other's load order: by the time anything is
 * running, everything has been declared. Registration is also idempotent and
 * order-independent on purpose (see the facet and theme registries), so the
 * phase is an optimisation rather than a correctness crutch — a mod that
 * registers late still works, it just may flicker.
 */

/** Common to both sides. A mod may implement either or both. */
interface ModModuleBase<Host> {
  /**
   * Declare things. Runs for every mod before any mod activates.
   *
   * Must be side-effect free beyond registration: no timers, no I/O, no
   * reading of state that another mod might not have declared yet.
   */
  register?(host: Host): void
  /** Start doing things. Runs after every mod has registered. */
  activate?(host: Host): void | Promise<void>
  /** Stop. Best-effort; the process may exit without calling it. */
  deactivate?(): void | Promise<void>
}

/**
 * The subset of spaceterm a mod's code is handed.
 *
 * Deliberately an *object*, not module imports: it is where per-mod scoping
 * lives, it is a readable list of what a mod can do, and it is the seam that
 * lets a mod be tested without a server. In-process this is a convenience and
 * a declaration rather than an enforcement — a mod can import whatever it
 * likes — which is the honest position and matches `mod-manifest.ts`.
 */
export interface ModHostBase {
  /** This mod's id. The namespace for its facets, themes and envelopes. */
  readonly modId: string
  log(line: string): void
}

export type ServerModModule<Host extends ModHostBase> = ModModuleBase<Host>
export type ClientModModule<Host extends ModHostBase> = ModModuleBase<Host>

/** What a loader reports back, per mod. */
export interface ModLoadResult {
  modId: string
  /** False when `register` or `activate` threw. The mod is left inert. */
  ok: boolean
  error?: string
}

/**
 * Run one phase over every mod, containing failures to the mod that caused
 * them.
 *
 * Shared by both loaders because the containment rule is the same on both
 * sides and is the whole reason a loader exists rather than a bare loop: one
 * mod throwing must not stop the mods after it in the list from loading.
 */
export function runModPhase<Host extends ModHostBase, M extends ModModuleBase<Host>>(
  mods: ReadonlyArray<{ modId: string; module: M }>,
  phase: 'register' | 'activate',
  hostFor: (modId: string) => Host,
  failed: Set<string>,
): ModLoadResult[] {
  const results: ModLoadResult[] = []
  for (const { modId, module } of mods) {
    // A mod that failed `register` never activates: its declarations are
    // half-made, and running it anyway is how one broken mod becomes several.
    if (failed.has(modId)) continue

    const fn = module[phase]
    if (!fn) {
      results.push({ modId, ok: true })
      continue
    }
    try {
      const host = hostFor(modId)
      const returned = fn.call(module, host)
      // An async `activate` that rejects is contained too — otherwise it
      // becomes an unhandled rejection with no indication of which mod.
      if (returned instanceof Promise) {
        void returned.catch((err: unknown) => {
          failed.add(modId)
          host.log(`[mods] ${modId} failed during ${phase}: ${describeError(err)}`)
        })
      }
      results.push({ modId, ok: true })
    } catch (err: unknown) {
      failed.add(modId)
      results.push({ modId, ok: false, error: describeError(err) })
    }
  }
  return results
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message
  return String(err)
}
