import type { ClientDevice } from '../shared/protocol'

const DEVICE_KEY = 'spaceterm:device-id'

/**
 * This phone, as the server knows it: the same id every time the page loads,
 * so Control stays on the phone across a closed app or a reload. Without
 * storage (private mode) it lasts only as long as the page.
 */
export function phoneDevice(): ClientDevice {
  let id: string | null = null
  try { id = localStorage.getItem(DEVICE_KEY) } catch { /* no storage */ }
  if (!id) {
    // Not randomUUID: that needs a secure context, which a page over plain
    // http on the tailnet is not.
    id = `phone-${Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('')}`
    try { localStorage.setItem(DEVICE_KEY, id) } catch { /* this page only */ }
  }
  return { id, label: 'Phone' }
}
