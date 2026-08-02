import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { parseModManifest, type ModCapability, type ModManifest } from '../shared/mod-manifest'

/**
 * The manifests found on disk, read once at server start.
 *
 * Layout is one directory per mod under `<SPACETERM_HOME>/mods/`, each with a
 * `mod.json`. Directory name and manifest `id` must agree, so a mod's identity
 * is visible from `ls` and cannot be quietly different from its folder.
 *
 * ## What "not found" means
 *
 * A connection naming a mod with no manifest runs *unscoped*, with a log line.
 * That is the deliberate migration shape: the nine existing MCP tools declare
 * nothing and must keep working, and a mod under development should not have
 * to write a manifest before its first message goes through. Scoping is
 * something a mod opts into by shipping a manifest, and the log makes the
 * un-opted case visible rather than silent.
 *
 * Loading is synchronous and eager because it happens once, at startup, before
 * any script can connect — an async load would mean the first connection
 * racing it.
 */
export class ModRegistry {
  private readonly manifests = new Map<string, ModManifest>()

  constructor(private readonly log: (line: string) => void) {}

  /**
   * Read every `mods/<id>/mod.json` under `home`. Never throws: a broken
   * manifest disables one mod with a complaint, rather than taking down the
   * server that was reading it.
   */
  loadFrom(home: string): void {
    const root = join(home, 'mods')
    if (!existsSync(root)) return

    let entries: string[]
    try {
      entries = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch (err: unknown) {
      this.log(`[mods] cannot read ${root}: ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    for (const dir of entries) {
      const path = join(root, dir, 'mod.json')
      if (!existsSync(path)) continue

      let raw: unknown
      try {
        raw = JSON.parse(readFileSync(path, 'utf-8'))
      } catch (err: unknown) {
        this.log(`[mods] ${dir}: unreadable mod.json — ${err instanceof Error ? err.message : String(err)}`)
        continue
      }

      const parsed = parseModManifest(raw)
      if (!parsed.ok) {
        this.log(`[mods] ${dir}: ${parsed.error}`)
        continue
      }
      if (parsed.manifest.id !== dir) {
        this.log(`[mods] ${dir}: manifest id is "${parsed.manifest.id}"; directory and id must match`)
        continue
      }

      this.manifests.set(parsed.manifest.id, parsed.manifest)
      this.log(`[mods] ${parsed.manifest.id}@${parsed.manifest.version} — ${parsed.manifest.capabilities.join(', ') || 'no capabilities'}`)
    }
  }

  /** Register a manifest directly. For tests, and for in-repo mods later. */
  add(manifest: ModManifest): void {
    this.manifests.set(manifest.id, manifest)
  }

  /** What this mod declared, or `null` if nothing declared it. */
  capabilitiesFor(modId: string): readonly ModCapability[] | null {
    return this.manifests.get(modId)?.capabilities ?? null
  }

  /** Every loaded manifest, for the mod list and for diagnostics. */
  all(): readonly ModManifest[] {
    return [...this.manifests.values()]
  }

  /**
   * Peers a loaded mod named that are not themselves loaded.
   *
   * Reported, never enforced: a missing peer is a diagnostic because a mod
   * that degrades gracefully without one is the behaviour to encourage, and
   * because the alternative is a dependency solver nobody asked for.
   */
  missingPeers(): Array<{ modId: string; peer: string; range: string }> {
    const missing: Array<{ modId: string; peer: string; range: string }> = []
    for (const manifest of this.manifests.values()) {
      for (const [peer, range] of Object.entries(manifest.peers ?? {})) {
        if (!this.manifests.has(peer)) missing.push({ modId: manifest.id, peer, range })
      }
    }
    return missing
  }
}
