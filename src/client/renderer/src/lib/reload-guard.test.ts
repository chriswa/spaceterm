import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ReloadGuard } from './reload-guard'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('ReloadGuard', () => {
  it('is free once every hold is let go, a turn later, so the work’s own caller goes first', async () => {
    const guard = new ReloadGuard()
    const a = guard.hold()
    const b = guard.hold()
    const freed = vi.fn()
    void guard.free().then(freed)
    a()
    a()
    await vi.advanceTimersByTimeAsync(0)
    expect(freed).not.toHaveBeenCalled()
    b()
    expect(guard.held).toBe(false)
    await Promise.resolve()
    expect(freed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(0)
    expect(freed).toHaveBeenCalled()
  })

  it('waits on for a hold taken in that turn', async () => {
    const guard = new ReloadGuard()
    const freed = vi.fn()
    const first = guard.hold()
    void guard.free().then(freed)
    first()
    const second = guard.hold()
    await vi.advanceTimersByTimeAsync(0)
    expect(freed).not.toHaveBeenCalled()
    second()
    await vi.advanceTimersByTimeAsync(0)
    expect(freed).toHaveBeenCalled()
  })
})
