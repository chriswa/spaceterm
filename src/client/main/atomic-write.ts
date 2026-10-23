import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { dirname } from 'path'

/**
 * Replace `file` with `data` so a reader never sees a torn file: write a temp
 * file beside it, fsync, rename over.
 *
 * The temp name is unique per process because more than one client can run
 * against the same `~/.spaceterm`. With a shared temp name, one client's
 * rename moves the file out from under the other's, and the second rename
 * throws ENOENT.
 */
export function writeFileAtomicSync(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, data, 'utf-8')
    const fd = openSync(tmp, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, file)
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* already gone */ }
    throw err
  }
}
