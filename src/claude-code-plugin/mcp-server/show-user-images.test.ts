import { describe, expect, it } from 'vitest'
import { checkImages } from './show-user-images'

const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('checkImages', () => {
  const files: Record<string, { size: number; head: Uint8Array }> = {
    '/game/shot.png': { size: 1000, head: PNG_HEAD },
    '/game/notes.txt': { size: 10, head: new TextEncoder().encode('just notes') },
    '/game/huge.png': { size: 100 * 1024 * 1024, head: PNG_HEAD },
  }
  const read = (file: string) => {
    const found = files[file]
    if (!found) throw new Error('ENOENT')
    return found
  }

  it('resolves a path against the agent\'s directory and keeps its caption', () => {
    expect(checkImages([{ path: 'shot.png', caption: ' Dusk ' }], '/game', read))
      .toEqual({ ok: [{ path: '/game/shot.png', caption: 'Dusk' }], problems: [] })
  })

  it('says why each picture it leaves out cannot be shown', () => {
    const { ok, problems } = checkImages([{ path: '/game/notes.txt' }, { path: '/game/huge.png' }, { path: '/nope.png' }, { path: '/game/shot.png' }], '/', read)
    expect(ok).toEqual([{ path: '/game/shot.png' }])
    expect(problems).toEqual([
      expect.stringContaining('not a PNG'),
      expect.stringContaining('limit'),
      expect.stringContaining('cannot be read'),
    ])
  })
})
