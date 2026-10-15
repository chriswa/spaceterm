import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { FpsCounter } from './FpsCounter'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Frames the test hands out itself, at whatever timestamps it likes. */
function stubFrames() {
  let pending: FrameRequestCallback | null = null
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { pending = cb; return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => { pending = null })
  return {
    /** Draws `count` frames `gapMs` apart, from `start`. */
    run(start: number, count: number, gapMs: number) {
      act(() => {
        for (let i = 0; i < count; i++) pending?.(start + i * gapMs)
      })
    },
    get waiting() { return pending !== null }
  }
}

describe('FpsCounter', () => {
  it('shows nothing until a reading, then the frames a second, and follows a slowdown', () => {
    const frames = stubFrames()
    const { container } = render(<FpsCounter />)
    expect(container.textContent).toBe('')

    frames.run(0, 32, 1000 / 60)
    expect(container.textContent).toBe('60')

    frames.run(1000, 12, 1000 / 20)
    expect(container.textContent).toBe('20')
  })

  it('stops asking for frames when it goes', () => {
    const frames = stubFrames()
    const { unmount } = render(<FpsCounter />)
    expect(frames.waiting).toBe(true)
    unmount()
    expect(frames.waiting).toBe(false)
  })
})
