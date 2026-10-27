/**
 * `localStorage`, or null where there is none to have: a private window, or
 * storage turned off. What is kept with it is a convenience, so a caller
 * treats null — and a read or write that throws — as nothing remembered.
 */

export interface MemoryStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function browserStorage(): MemoryStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}
