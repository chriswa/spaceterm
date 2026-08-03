import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { RootNode } from './RootNode'
import { ROOT_NODE_RADIUS } from '../lib/constants'
import { ROOT_CHROME_SCALE } from '../../../../shared/card-types'

/**
 * The canvas origin marker, which is a `CardShell` like every other node but the
 * only one with no entry in the node store — so everything `CardShell` derives
 * from a node's type, the root has to be given another way.
 *
 * It is also the one node drawn at label scale, which is what makes the two
 * things below worth pinning: its chrome needs a compensating scale to stay
 * legible, and that chrome must still obey the same show-on-focus rule as every
 * other card's action bar. Both were wrong at once when the node grew.
 */

function renderRoot(focused: boolean) {
  return render(
    <RootNode
      focused={focused}
      selected={false}
      onClick={vi.fn()}
      archivedChildren={[]}
      onUnarchive={vi.fn()}
      onArchiveDelete={vi.fn()}
      onOpenArchiveSearch={vi.fn()}
      onAddNode={vi.fn()}
    />
  )
}

function shell(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[data-node-id="root"]') as HTMLElement | null
  if (!el) throw new Error('no root shell')
  return el
}

afterEach(cleanup)

describe('the root node’s box', () => {
  it('is its radius square, centred on the world origin', () => {
    // Placement, camera-fit, snap guides and drag-select all measure the root
    // from ROOT_NODE_RADIUS. A box that disagreed with the constant would put
    // every one of them somewhere the node is not.
    const { container } = renderRoot(false)
    const style = shell(container).style
    expect(style.width).toBe(`${ROOT_NODE_RADIUS * 2}px`)
    expect(style.left).toBe(`${-ROOT_NODE_RADIUS}px`)
    expect(style.top).toBe(`${-ROOT_NODE_RADIUS}px`)
  })

  it('publishes the chrome scale its size calls for', () => {
    // The root has no card type for cardChromeScale() to read, and needs the
    // scale more than any card: focusing it fits a label-scale box, so its
    // buttons would otherwise render at a fraction of their designed size.
    const { container } = renderRoot(false)
    expect(shell(container).style.getPropertyValue('--card-chrome-scale'))
      .toBe(String(ROOT_CHROME_SCALE))
  })
})

describe('the root node’s buttons', () => {
  it('are marked focused only when the node is, which is what reveals them', () => {
    // The archive and add-child buttons hide with opacity, keyed off this
    // class — they stay in layout so focusing the node cannot shift it. They
    // were visible on an unfocused root until the shell started marking focus,
    // which is not how any other card behaves.
    const unfocused = renderRoot(false)
    expect(shell(unfocused.container).className).not.toContain('card-shell--focused')
    cleanup()

    const focused = renderRoot(true)
    expect(shell(focused.container).className).toContain('card-shell--focused')
  })

  it('stay in the DOM unfocused, so the row keeps the height the visual is offset by', () => {
    // RootNode positions its facet by subtracting this row's layout height. If
    // the row were unmounted rather than faded, the node would jump on focus.
    const { container } = renderRoot(false)
    expect(container.querySelectorAll('.card-shell__hidden-head-actions button').length).toBe(2)
  })
})
