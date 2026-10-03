import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react'
import { installFakeBridge } from '@/testing/fake-bridge'
import { asNodeId } from '../shared/ids'
import { SummarizerButton } from './SummarizerButton'

const NODE = asNodeId('n1')

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('SummarizerButton', () => {
  it('a long press offers to abandon, and abandoning ends the conversation without listening', () => {
    vi.useFakeTimers()
    const bridge = installFakeBridge()
    render(<SummarizerButton nodeId={NODE} />)
    const button = screen.getByRole('button', { name: /Summary Chat/ })
    fireEvent.pointerDown(button)
    act(() => { vi.advanceTimersByTime(450) })
    // The release's click must not also start listening.
    fireEvent.pointerUp(button)
    fireEvent.click(button)
    expect(bridge.callsTo('dictation.start')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Abandon summarizer' }))
    expect(bridge.callsTo('endSummaryChat')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Abandon summarizer' })).toBeNull()
  })

  it('tapping outside the sheet keeps the conversation', () => {
    vi.useFakeTimers()
    const bridge = installFakeBridge()
    const { container } = render(<SummarizerButton nodeId={NODE} />)
    fireEvent.pointerDown(screen.getByRole('button', { name: /Summary Chat/ }))
    act(() => { vi.advanceTimersByTime(450) })
    fireEvent.click(container.ownerDocument.querySelector('.m-summarizer-sheet') as HTMLElement)
    expect(screen.queryByRole('button', { name: 'Abandon summarizer' })).toBeNull()
    expect(bridge.callsTo('endSummaryChat')).toHaveLength(0)
  })
})
