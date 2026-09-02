import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  readRestartFlag,
  writeRestartFlag,
  clearRestartFlag,
  restartFlagPath,
  watchRestartFlag
} from './restart-flag'

const created: string[] = []

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-flag-'))
  created.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('restart flag', () => {
  it('reads null when no flag is set', () => {
    expect(readRestartFlag(tmpDir())).toBeNull()
  })

  it('round-trips reason and timestamp', () => {
    const dir = tmpDir()
    writeRestartFlag('CLAUDE.md changed', dir, 1234)
    expect(readRestartFlag(dir)).toEqual({ reason: 'CLAUDE.md changed', requestedAt: 1234 })
  })

  it('clearing removes the flag', () => {
    const dir = tmpDir()
    writeRestartFlag('x', dir)
    clearRestartFlag(dir)
    expect(readRestartFlag(dir)).toBeNull()
  })

  it('clearing a missing flag is a no-op', () => {
    expect(() => clearRestartFlag(tmpDir())).not.toThrow()
  })

  it('treats a corrupt file as a restart request with no reason', () => {
    const dir = tmpDir()
    fs.writeFileSync(restartFlagPath(dir), 'not json')
    expect(readRestartFlag(dir)).toEqual({ reason: '', requestedAt: 0 })
  })

  it('re-reads and reports the flag on a watch event for its file, ignoring others', () => {
    const dir = tmpDir()
    const seen: (string | null)[] = []
    // Inject the watch primitive so events are driven deterministically rather
    // than racing OS filesystem-event delivery.
    let fire: (filename: string | null) => void = () => {}
    const stop = watchRestartFlag(
      (flag) => seen.push(flag ? flag.reason : null),
      dir,
      (_dir, onEvent) => {
        fire = onEvent
        return () => {}
      }
    )

    writeRestartFlag('needs restart', dir)
    fire('restart-required.json')
    fire('some-other-file') // unrelated change: must not re-report
    clearRestartFlag(dir)
    fire(null) // platform reported no filename: re-read anyway
    stop()

    expect(seen).toEqual(['needs restart', null])
  })
})
