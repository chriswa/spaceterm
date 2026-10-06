import { describe, expect, it } from 'vitest'
import { measure } from './page-memory'

describe('measure', () => {
  it('adds up every canvas\'s backing store and names the largest', () => {
    document.body.innerHTML = `
      <div class="card-shell"><canvas class="snapshot" width="80" height="45"></canvas></div>
      <div class="xterm"><canvas class="xterm-webgl" width="1000" height="500"></canvas></div>`
    const { canvasBytes, summary } = measure(document, { width: 400, height: 800 })
    expect(canvasBytes).toBe((80 * 45 + 1000 * 500) * 4)
    expect(summary).toMatch(/^canvases 2 = 1\.9MB, largest 1000x500 in xterm-webgl; \d+ elements; \d+ cards on screen$/)
  })
})
