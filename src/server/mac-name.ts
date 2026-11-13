/**
 * What the phone calls this Mac: in brackets before the title of every
 * notification it sends (`[Work] Fix the build`).
 * One phone hears from several Macs (src/mobile/ios/macs.local), so a
 * notification has to say whose agent is asking.
 *
 * `~/.spaceterm/mac-name`, one line, if the user has named it ("Work"), else
 * the name in System Settings → General → Sharing. The file is read each time,
 * so naming a Mac needs no restart.
 */

import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export interface MacNameSources {
  /** The `mac-name` file's contents, or null when there is none. */
  chosen(): string | null
  /** The Mac's own name, or null when it cannot be had. */
  computerName(): string | null
  hostname(): string
}

export function macName(sources: MacNameSources): string {
  const chosen = sources.chosen()?.trim()
  if (chosen) return chosen
  return sources.computerName()?.trim() || sources.hostname().replace(/\.local$/, '')
}

/** A notification's title, led by the Mac that sent it. */
export function fromMac(mac: string, title: string): string {
  return `[${mac}] ${title}`
}

export function realMacName(dir: string): () => string {
  let computerName: string | null | undefined
  const sources: MacNameSources = {
    chosen() {
      try {
        return fs.readFileSync(path.join(dir, 'mac-name'), 'utf8')
      } catch {
        return null
      }
    },
    computerName() {
      if (computerName === undefined) {
        try {
          computerName = execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000 })
        } catch {
          computerName = null
        }
      }
      return computerName
    },
    hostname: () => os.hostname(),
  }
  return () => macName(sources)
}
