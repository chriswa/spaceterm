import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { NodeLabels } from './NodeLabels'
import type { NodeLabel } from '../lib/node-label'
import { COLOR_PRESET_MAP, DEFAULT_PRESET } from '../lib/color-presets'
import { asNodeId, type NodeId } from '../../../../shared/ids'

/**
 * What a node label owes the canvas it is drawn on.
 *
 * The interesting parts are not the text — they are the things that keep a
 * caption from being mistaken for the node it captions: it wears that node's
 * colour, it navigates relative to it, and it must not answer to the two
 * selectors the viewport uses to find cards.
 */

const NODE = asNodeId('term-1')

function label(overrides: Partial<NodeLabel> = {}): NodeLabel {
  return {
    nodeId: NODE, lines: ['Deploy', 'pipeline'],
    x: 200, y: -100, width: 900, height: 1000,
    anchorX: 200, anchorY: 900,
    ...overrides
  }
}

function renderLabels(labels: NodeLabel[], onClick = vi.fn(), freshness = new Map<NodeId, number>()) {
  const presets = { [NODE]: COLOR_PRESET_MAP['teal'] }
  const { container } = render(
    <NodeLabels labels={labels} resolvedPresets={presets} nodeFreshness={freshness} onLabelClick={onClick} />
  )
  return { container, onClick }
}

afterEach(cleanup)

describe('NodeLabels', () => {
  it('draws the label box at the position it was laid out at', () => {
    const { container } = renderLabels([label()])
    const el = container.querySelector('.node-label') as HTMLElement
    expect(el.style.left).toBe('-250px')  // 200 - 900/2
    expect(el.style.top).toBe('-600px')   // -100 - 1000/2
    expect(el.style.width).toBe('900px')
    expect(el.style.height).toBe('1000px')
  })

  it('wears the colour of the node supplying it', () => {
    const { container } = renderLabels([label()])
    const el = container.querySelector('.node-label') as HTMLElement
    expect(el.style.getPropertyValue('--node-label-fg')).toBe(COLOR_PRESET_MAP['teal'].titleBarBg)
  })

  it('falls back to the default preset for a node with no resolved colour', () => {
    const other = asNodeId('term-2')
    const { container } = renderLabels([label({ nodeId: other })])
    const el = container.querySelector('.node-label') as HTMLElement
    expect(el.style.getPropertyValue('--node-label-fg')).toBe(DEFAULT_PRESET.titleBarBg)
  })

  it('renders the pre-broken lines verbatim, so nothing re-wraps them', () => {
    const { container } = renderLabels([label({ lines: ['Deploy', 'pipeline'] })])
    expect(container.querySelector('.node-label__text')?.textContent).toBe('Deploy\npipeline')
  })

  it('navigates from the node that supplies the label', () => {
    const { container, onClick } = renderLabels([label()])
    fireEvent.click(container.querySelector('.node-label')!)
    expect(onClick).toHaveBeenCalledWith(NODE)
  })

  it('counts as canvas chrome, so it never starts a pan or an edge split', () => {
    const { container } = renderLabels([label()])
    expect(container.querySelector('.node-label')!.closest('.canvas-node')).not.toBeNull()
  })

  it('does not claim to be its node', () => {
    // `data-node-id` is how cmd-click and the selection flash find a card. A
    // label answering to it would hand both the wrong element.
    const { container } = renderLabels([label()])
    expect(container.querySelector('[data-node-id]')).toBeNull()
  })

  it('drains with its node under the dim-stale view', () => {
    const { container } = renderLabels([label()], vi.fn(), new Map([[NODE, 0.4]]))
    expect((container.querySelector('.node-label') as HTMLElement).style.filter)
      .toBe('saturate(0.55) brightness(0.76)')
  })

  it('leaves an undrained label unfiltered rather than at saturate(1)', () => {
    const { container } = renderLabels([label()])
    expect((container.querySelector('.node-label') as HTMLElement).style.filter).toBe('')
  })
})
