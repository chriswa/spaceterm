import { execFile } from 'child_process'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { imageType } from '../shared/image-type'
import { SOCKET_DIR } from '../shared/protocol'

/**
 * Pictures agents show the user in Control's transcript (`show_user_images`).
 *
 * Copied in the moment they are shown, since an agent's screenshot file is
 * usually overwritten by its next one, and named by their content, so showing
 * the same picture twice keeps one copy. Each gets a small JPEG beside it for
 * the transcript's list, which on the phone matters: iOS kills a page that
 * decodes too many full-size screenshots at once. The whole picture is only
 * fetched when the user opens it.
 *
 * Only ever for the user's eyes. Control is told how many pictures there are
 * and their captions, and nothing here is reachable from its tools.
 */

export const CONTROL_IMAGES_DIR = path.join(SOCKET_DIR, 'control-images')

/** A picture bigger than this on disk is refused rather than copied. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024
/** The stored picture's longest side, at most: a 5K screenshot is more than any screen here shows. */
export const FULL_MAX_PX = 2560
/** The list's small copy's longest side. */
export const THUMB_MAX_PX = 480

const MIME_BY_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }

/** A stored picture's id: its content hash and type. Anything else asked for is refused, so no request reaches outside the folder. */
const ID = /^([0-9a-f]{64})\.(png|jpg|gif|webp)$/

/** The file system and image tools, as a seam so tests need neither. */
export interface ControlImageDeps {
  dir: string
  size(file: string): number
  readFile(file: string): Buffer
  exists(file: string): boolean
  /** Write `data` at `file`, whole or not at all. */
  writeFile(file: string, data: Buffer): void
  /** A picture's width and height, or undefined when they cannot be read. */
  dimensions(file: string): Promise<{ width: number; height: number } | undefined>
  /** A copy of `src` at `dest`, `maxPx` on its longest side; as JPEG when `jpeg`, else in its own format. Rejects on failure. */
  resize(src: string, dest: string, maxPx: number, jpeg: boolean): Promise<void>
}

function sips(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('sips', args, { timeout: 30_000 }, (err, stdout) => err ? reject(err) : resolve(stdout))
  })
}

/** macOS's `sips` does the image work: it is on every Mac, so there is nothing to install. */
export const REAL_CONTROL_IMAGE_DEPS: ControlImageDeps = {
  dir: CONTROL_IMAGES_DIR,
  size: (file) => fs.statSync(file).size,
  readFile: (file) => fs.readFileSync(file),
  exists: (file) => fs.existsSync(file),
  writeFile: (file, data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, data)
    fs.renameSync(tmp, file)
  },
  dimensions: async (file) => {
    try {
      const out = await sips(['-g', 'pixelWidth', '-g', 'pixelHeight', file])
      const width = Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1])
      const height = Number(/pixelHeight:\s*(\d+)/.exec(out)?.[1])
      return width > 0 && height > 0 ? { width, height } : undefined
    } catch {
      return undefined
    }
  },
  resize: async (src, dest, maxPx, jpeg) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const tmp = `${dest}.${process.pid}.tmp`
    await sips([...(jpeg ? ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80'] : []), '-Z', String(maxPx), src, '--out', tmp])
    fs.renameSync(tmp, dest)
  },
}

export type StoreResult = { ok: true; id: string } | { ok: false; error: string }

export class ControlImages {
  constructor(private readonly deps: ControlImageDeps = REAL_CONTROL_IMAGE_DEPS) {}

  /** Copy the picture at `file` in, and make its small copy. Never throws. */
  async store(file: string): Promise<StoreResult> {
    try {
      const size = this.deps.size(file)
      if (size > MAX_IMAGE_BYTES) return { ok: false, error: `${path.basename(file)} is ${Math.round(size / 1024 / 1024)} MB; the most is ${MAX_IMAGE_BYTES / 1024 / 1024} MB` }
      const bytes = this.deps.readFile(file)
      const type = imageType(bytes)
      if (!type) return { ok: false, error: `${path.basename(file)} is not a PNG, JPEG, GIF or WebP image` }
      const id = `${createHash('sha256').update(bytes).digest('hex')}.${type.ext}`
      const full = path.join(this.deps.dir, id)
      if (this.deps.exists(full)) return { ok: true, id }
      const dims = await this.deps.dimensions(file)
      const longest = dims ? Math.max(dims.width, dims.height) : undefined
      // A GIF is kept as it is: resizing it would keep only its first frame.
      if (type.ext !== 'gif' && longest !== undefined && longest > FULL_MAX_PX) {
        await this.deps.resize(file, full, FULL_MAX_PX, false).catch(() => this.deps.writeFile(full, bytes))
      } else {
        this.deps.writeFile(full, bytes)
      }
      // Without a small copy the list shows the whole picture, which is only slower.
      if (longest === undefined || longest > THUMB_MAX_PX) {
        await this.deps.resize(full, thumbPath(this.deps.dir, id), THUMB_MAX_PX, true).catch(() => undefined)
      }
      return { ok: true, id }
    } catch (err) {
      return { ok: false, error: `could not copy ${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  /** A stored picture, small or whole, or undefined if there is none by that id. The small copy falls back to the whole one. */
  read(id: string, size: 'thumb' | 'full'): { mime: string; data: Buffer } | undefined {
    const match = ID.exec(id)
    if (!match) return undefined
    const thumb = thumbPath(this.deps.dir, id)
    try {
      if (size === 'thumb' && this.deps.exists(thumb)) return { mime: 'image/jpeg', data: this.deps.readFile(thumb) }
      const full = path.join(this.deps.dir, id)
      if (!this.deps.exists(full)) return undefined
      return { mime: MIME_BY_EXT[match[2]], data: this.deps.readFile(full) }
    } catch {
      return undefined
    }
  }
}

function thumbPath(dir: string, id: string): string {
  return path.join(dir, `${id.slice(0, id.indexOf('.'))}.thumb.jpg`)
}
