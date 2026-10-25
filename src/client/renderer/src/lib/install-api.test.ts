import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PlatformApi } from '../../../../shared/api'
import type { ServerTransport, TransportHandlers } from '../../../../shared/server-client'
import { ReloadGuard } from './reload-guard'
import { installApi } from './install-api'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

/** A transport the test opens and drops by hand. */
function manualTransport() {
  let handlers: TransportHandlers | null = null
  const transport: ServerTransport = {
    open: (h) => { handlers = h },
    send: () => undefined,
    close: () => { handlers = null },
  }
  return {
    transport,
    accept: () => handlers!.onOpen(),
    drop: () => { const h = handlers!; handlers = null; h.onClose() },
  }
}

const platform = {
  log: () => undefined,
  onFocusRequest: () => () => undefined,
} as unknown as PlatformApi

describe('installApi’s resync reload', () => {
  it('reloads on a reconnect at once when nothing holds the page', async () => {
    const t = manualTransport()
    const reload = vi.fn()
    const installing = installApi(t.transport, platform, 'test', { id: 'phone-1', label: 'Phone' }, { reload, guard: new ReloadGuard() })
    t.accept()
    await installing
    t.drop()
    await vi.advanceTimersByTimeAsync(1000)
    t.accept()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('waits for a dictation under way to end, through any number of reconnects', async () => {
    const t = manualTransport()
    const reload = vi.fn()
    const guard = new ReloadGuard()
    const installing = installApi(t.transport, platform, 'test', { id: 'phone-1', label: 'Phone' }, { reload, guard })
    t.accept()
    await installing
    const dictating = guard.hold()
    for (let i = 0; i < 2; i++) {
      t.drop()
      await vi.advanceTimersByTimeAsync(1000)
      t.accept()
    }
    await vi.advanceTimersByTimeAsync(10_000)
    expect(reload).not.toHaveBeenCalled()
    dictating()
    await vi.advanceTimersByTimeAsync(0)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
