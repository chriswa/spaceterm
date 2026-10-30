import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { CrabGroup } from './CrabGroup'
import { installFakeBridge } from '../../testing/fake-bridge'
import type { CrabEntry } from '../../lib/crab-nav'
import { asNodeId } from '../../../../../shared/ids'

/** The toolbar row draws a surface's auto-stamp in place of its agent's icon. */
function crab(over: Partial<CrabEntry> = {}): CrabEntry {
  return {
    nodeId: asNodeId('n1'), claudeSessionIds: [], kind: 'claude', color: 'orange', hat: 'crown',
    effortSteps: 1, unviewed: false, asleep: false, createdAt: '', sortOrder: 0, title: 'Surface',
    ...over,
  }
}

function renderGroup(entry: CrabEntry, layout: 'row' | 'list' = 'row') {
  return render(
    <CrabGroup layout={layout} crabs={[entry]} onCrabClick={() => {}} onCrabReorder={() => {}}
      selectedNodeId={null} crabNavEvent={null} now={0} />,
  )
}

const STAMP = 'url("data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E")'

beforeEach(() => { installFakeBridge(globalThis as never) })
afterEach(cleanup)

describe('CrabGroup stamps', () => {
  it('masks a stamped surface with its stamp, keeps its colour, and drops the hat and effort signs', () => {
    const { container } = renderGroup(crab({ stampMask: STAMP }))
    const button = container.querySelector<HTMLElement>('.toolbar__crab')!
    expect(button.classList).toContain('toolbar__crab--orange')
    expect(button.classList).toContain('toolbar__crab--stamped')
    expect(container.querySelector<HTMLElement>('.toolbar__crab-mark')!.style.maskImage).toBe(STAMP)
    expect(container.querySelector('.toolbar__crab-hat')).toBeNull()
    expect(container.querySelector('.toolbar__crab-effort')).toBeNull()
  })

  it('falls back to the agent icon, hat and all, until a stamp has been drawn', () => {
    const { container } = renderGroup(crab())
    expect(container.querySelector('.toolbar__crab--stamped')).toBeNull()
    expect(container.querySelector<HTMLElement>('.toolbar__crab-mark')!.style.maskImage).not.toBe(STAMP)
    expect(container.querySelector('.toolbar__crab-hat')).not.toBeNull()
  })

  it('keeps the agent icon in the phone list, which shows the stamp in its own column', () => {
    const { container } = renderGroup(crab({ stampMask: STAMP }), 'list')
    expect(container.querySelector('.toolbar__crab--stamped')).toBeNull()
  })
})
