import type { NodeId } from '../shared/ids'

/**
 * One surface's composer text, kept in this browser: the draft in progress,
 * and the prompts already shipped, newest first.
 *
 * Written at the moment of each change, never from an effect after a render.
 * Shipping used to clear the draft by setting the text to '' and closing the
 * composer in the same update — the composer unmounted before the effect that
 * would have saved '' ever ran, and the sent prompt came back as a draft the
 * next time it opened.
 */

/** How many shipped prompts each surface remembers. */
export const HISTORY_LIMIT = 20

export type PromptStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export interface PromptStore {
  draft(): string
  setDraft(text: string): void
  /** The draft was sent: remember it, and start the next one empty. */
  shipped(text: string): void
  /** Shipped prompts, newest first. */
  history(): string[]
}

export function promptStore(nodeId: NodeId, storage: PromptStorage = localStorage): PromptStore {
  const draftKey = `mobile.draft.${nodeId}`
  const historyKey = `mobile.sent.${nodeId}`
  // Private mode and full storage throw; the text then lives as long as the page.
  const attempt = <T>(fn: () => T, fallback: T): T => {
    try { return fn() } catch { return fallback }
  }
  const history = (): string[] => attempt(() => {
    const parsed: unknown = JSON.parse(storage.getItem(historyKey) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : []
  }, [])
  const setDraft = (text: string) => attempt(() => {
    if (text) storage.setItem(draftKey, text)
    else storage.removeItem(draftKey)
  }, undefined)

  return {
    draft: () => attempt(() => storage.getItem(draftKey) ?? '', ''),
    setDraft,
    shipped(text) {
      const next = [text, ...history().filter((t) => t !== text)].slice(0, HISTORY_LIMIT)
      attempt(() => storage.setItem(historyKey, JSON.stringify(next)), undefined)
      setDraft('')
    },
    history
  }
}

/**
 * What the recall button brings back next: the newest prompt when the draft is
 * empty, then each older one in turn while the draft still holds the one it
 * last recalled. Null when there is nothing further back — or when the draft
 * holds new writing, which recalling would throw away.
 */
export function nextRecall(draft: string, history: string[]): string | null {
  if (draft === '') return history[0] ?? null
  const at = history.indexOf(draft)
  if (at === -1) return null
  return history[at + 1] ?? null
}
