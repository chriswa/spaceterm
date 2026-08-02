import { runModPhase, type ClientModModule, type ModHostBase, type ModLoadResult } from '../../../../shared/mod-module'
import { modChannel, type ModChannel, type ModMessageShape } from '../lib/mod-channel'
import * as summaryChat from './summary-chat'

/**
 * The renderer's mods, and the two-phase load that starts them.
 *
 * ## Why this is a static import list
 *
 * The renderer is a Vite bundle, so an in-repo mod is an import and nothing
 * more. Third-party client code loaded at runtime is a different problem —
 * dynamic import, CSP, a build the mod author runs — and this model defers it
 * rather than pretending to solve it. Everything below is written so that
 * swapping this array for a runtime-loaded list is the only change needed.
 */

/** What a client mod is handed. Scoped per mod by `modId`. */
export interface ClientModHost extends ModHostBase {
  /** This mod's own typed envelope channel to its server half. */
  channel<M extends ModMessageShape>(): ModChannel<M>
}

interface RegisteredClientMod {
  modId: string
  module: ClientModModule<ClientModHost>
}

const CLIENT_MODS: readonly RegisteredClientMod[] = [
  { modId: 'summary-chat', module: summaryChat },
]

const failed = new Set<string>()

function hostFor(modId: string): ClientModHost {
  return {
    modId,
    channel: <M extends ModMessageShape>() => modChannel<M>(modId),
    // Mods log through the same bridge as everything else, tagged so a noisy
    // mod is identifiable without reading its source.
    log: (line) => window.api.log(`[mod:${modId}] ${line}`),
  }
}

let loaded = false

/**
 * Register every mod, then activate every mod.
 *
 * Idempotent: the renderer mounts once, but React strict mode and a hot
 * reload both call it twice, and a mod's `register` running twice would
 * double-add its facets.
 */
export function loadClientMods(): ModLoadResult[] {
  if (loaded) return []
  loaded = true

  const registered = runModPhase(CLIENT_MODS, 'register', hostFor, failed)
  const activated = runModPhase(CLIENT_MODS, 'activate', hostFor, failed)

  const results = [...registered, ...activated].filter((r) => !r.ok)
  for (const result of results) {
    window.api.log(`[mods] ${result.modId} failed to load: ${result.error}`)
  }
  return results
}

/** Mods that threw during load. Rendered by nothing yet; read by tests. */
export function failedClientMods(): string[] {
  return [...failed]
}
