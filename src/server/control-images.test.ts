import { describe, expect, it } from 'vitest'
import * as path from 'path'
import { ControlImages, FULL_MAX_PX, MAX_IMAGE_BYTES, type ControlImageDeps } from './control-images'
import { imageType } from '../shared/image-type'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest of a png')])
const GIF = Buffer.from('GIF89a and the rest')

function fakeDeps(sources: Record<string, Buffer>, dims?: { width: number; height: number }) {
  const files = new Map<string, Buffer>(Object.entries(sources))
  const resized: Array<{ src: string; dest: string; maxPx: number; jpeg: boolean }> = []
  const deps: ControlImageDeps = {
    dir: '/store',
    size: (file) => { const data = files.get(file); if (!data) throw new Error('ENOENT'); return data.length },
    readFile: (file) => { const data = files.get(file); if (!data) throw new Error('ENOENT'); return data },
    exists: (file) => files.has(file),
    writeFile: (file, data) => { files.set(file, data) },
    dimensions: async () => dims,
    resize: async (src, dest, maxPx, jpeg) => {
      resized.push({ src, dest, maxPx, jpeg })
      files.set(dest, Buffer.from(`resized ${maxPx}`))
    },
  }
  return { deps, files, resized }
}

describe('imageType', () => {
  it('knows a picture by its first bytes, not its name', () => {
    expect(imageType(PNG)?.ext).toBe('png')
    expect(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.ext).toBe('jpg')
    expect(imageType(GIF)?.ext).toBe('gif')
    expect(imageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))?.ext).toBe('webp')
    expect(imageType(Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----'))).toBeUndefined()
  })
})

describe('ControlImages', () => {
  it('copies a picture in by its content, with a small copy beside it', async () => {
    const { deps, files, resized } = fakeDeps({ '/game/shot.png': PNG }, { width: 1920, height: 1080 })
    const images = new ControlImages(deps)
    const stored = await images.store('/game/shot.png')
    expect(stored.ok).toBe(true)
    if (!stored.ok) return
    expect(stored.id).toMatch(/^[0-9a-f]{64}\.png$/)
    // Overwriting the agent's file does not change what was shown.
    files.set('/game/shot.png', Buffer.from('next screenshot'))
    expect(images.read(stored.id, 'full')).toEqual({ mime: 'image/png', data: PNG })
    expect(resized).toEqual([expect.objectContaining({ src: path.join('/store', stored.id), jpeg: true })])
    expect(images.read(stored.id, 'thumb')?.mime).toBe('image/jpeg')
  })

  it('shrinks a picture larger than any screen, but never a GIF', async () => {
    const big = fakeDeps({ '/a.png': PNG, '/b.gif': GIF }, { width: 6000, height: 3000 })
    const images = new ControlImages(big.deps)
    await images.store('/a.png')
    await images.store('/b.gif')
    const fulls = big.resized.filter((r) => !r.jpeg)
    expect(fulls).toHaveLength(1)
    expect(fulls[0]).toMatchObject({ src: '/a.png', maxPx: FULL_MAX_PX })
  })

  it('makes no small copy of a picture already small, and reads the whole one for it', async () => {
    const { deps, resized } = fakeDeps({ '/small.png': PNG }, { width: 200, height: 100 })
    const images = new ControlImages(deps)
    const stored = await images.store('/small.png')
    expect(resized).toEqual([])
    expect(stored.ok && images.read(stored.id, 'thumb')).toEqual({ mime: 'image/png', data: PNG })
  })

  it('refuses what is not a picture, is too big, or is not there', async () => {
    const { deps } = fakeDeps({ '/key': Buffer.from('secret'), '/huge.png': Buffer.alloc(MAX_IMAGE_BYTES + 1) })
    const images = new ControlImages(deps)
    expect(await images.store('/key')).toMatchObject({ ok: false, error: expect.stringContaining('not a PNG') })
    expect(await images.store('/huge.png')).toMatchObject({ ok: false, error: expect.stringContaining('MB') })
    expect(await images.store('/missing.png')).toMatchObject({ ok: false })
  })

  it('reads nothing by an id that is not one of its own', () => {
    const { deps } = fakeDeps({ '/etc/passwd': Buffer.from('root') })
    const images = new ControlImages(deps)
    expect(images.read('../../etc/passwd', 'full')).toBeUndefined()
    expect(images.read(`${'a'.repeat(64)}.png`, 'full')).toBeUndefined()
  })
})
