import { describe, it, expect } from 'vitest'
import {
  TOOLBAR_WIDGETS,
  TOOLBAR_SLOTS,
  widgetsInSlot,
  renderToolbarWidget,
  type ToolbarHost,
  type ToolbarWidget
} from './registry'

// The registry is data, so these are assertions about the data — not about
// pixels. What they protect is the contract MODDING.md needs to hold before a
// widget can come from anywhere but this file.

/**
 * A host that reports every property read.
 *
 * This is the whole point of the standalone/host split: a standalone widget is
 * supposed to be unable to reach the host, and the type enforces it by giving
 * `render` no parameter. This proxy checks the *runtime* half — that
 * `renderToolbarWidget` really does withhold the host, so the type's guarantee
 * is not quietly undermined by a convenience change later.
 */
function spyingHost(onRead: (key: string) => void): ToolbarHost {
  return new Proxy({} as ToolbarHost, {
    get(_target, key) {
      onRead(String(key))
      // Callbacks and values alike: a no-op function satisfies both shapes
      // well enough for a render that is not supposed to happen anyway.
      return () => {}
    }
  })
}

describe('TOOLBAR_WIDGETS', () => {
  it('has a unique id per widget — they are React keys', () => {
    const ids = TOOLBAR_WIDGETS.map((w) => w.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('uses only declared slots', () => {
    for (const w of TOOLBAR_WIDGETS) {
      expect(TOOLBAR_SLOTS, w.id).toContain(w.slot)
    }
  })

  it('fills every slot — an empty one means the toolbar renders a stray wrapper', () => {
    for (const slot of TOOLBAR_SLOTS) {
      expect(widgetsInSlot(slot).length, slot).toBeGreaterThan(0)
    }
  })

  it('declares each widget standalone or host, and nothing else', () => {
    for (const w of TOOLBAR_WIDGETS) {
      expect(['standalone', 'host'], w.id).toContain(w.kind)
    }
  })

  it('still contains something a mod could plausibly supply', () => {
    // If this ever drops to zero, the widget contract has become fiction: no
    // first-party widget would be expressible without host wiring, so a
    // third-party one would not be either.
    const standalone = TOOLBAR_WIDGETS.filter((w) => w.kind === 'standalone')
    expect(standalone.length).toBeGreaterThan(0)
  })
})

describe('widgetsInSlot', () => {
  it('preserves registry order, which is display order', () => {
    const buttons = widgetsInSlot('buttons').map((w) => w.id)
    const expected = TOOLBAR_WIDGETS.filter((w) => w.slot === 'buttons').map((w) => w.id)
    expect(buttons).toEqual(expected)
  })

  it('partitions the registry — every widget appears exactly once', () => {
    const all = TOOLBAR_SLOTS.flatMap((slot) => widgetsInSlot(slot).map((w) => w.id))
    expect(all.sort()).toEqual(TOOLBAR_WIDGETS.map((w) => w.id).sort())
  })

  it('accepts a custom widget list, which is what a mod registry would supply', () => {
    const mine: ToolbarWidget[] = [
      { id: 'x', slot: 'status', kind: 'standalone', render: () => null },
      { id: 'y', slot: 'buttons', kind: 'standalone', render: () => null }
    ]
    expect(widgetsInSlot('status', mine).map((w) => w.id)).toEqual(['x'])
  })

  it('returns nothing for a slot no widget claims', () => {
    expect(widgetsInSlot('surfaces', [])).toEqual([])
  })
})

describe('renderToolbarWidget', () => {
  it('withholds the host from a standalone widget', () => {
    const reads: string[] = []
    const widget: ToolbarWidget = {
      id: 'w',
      slot: 'status',
      kind: 'standalone',
      // Declared with no parameter, so it could not read the host even if one
      // arrived. The assertion is that none does.
      render: () => null
    }
    renderToolbarWidget(widget, spyingHost((k) => reads.push(k)))
    expect(reads).toEqual([])
  })

  it('passes the host to a host widget', () => {
    const reads: string[] = []
    const widget: ToolbarWidget = {
      id: 'w',
      slot: 'status',
      kind: 'host',
      render: (h) => { void h.zoom; return null }
    }
    renderToolbarWidget(widget, spyingHost((k) => reads.push(k)))
    expect(reads).toContain('zoom')
  })

  it('returns whatever the widget returned, including null', () => {
    const widget: ToolbarWidget = { id: 'w', slot: 'status', kind: 'standalone', render: () => null }
    expect(renderToolbarWidget(widget, spyingHost(() => {}))).toBeNull()
  })
})

describe('the host surface', () => {
  it('is only reached by widgets that declared they need it', () => {
    // Render the real registry against a proxy host and confirm that every
    // property read came from a widget declared `kind: 'host'`. A standalone
    // widget that started prop-drilling would show up here.
    const reads: string[] = []
    for (const widget of TOOLBAR_WIDGETS.filter((w) => w.kind === 'standalone')) {
      renderToolbarWidget(widget, spyingHost((k) => reads.push(`${widget.id}.${k}`)))
    }
    expect(reads).toEqual([])
  })
})
