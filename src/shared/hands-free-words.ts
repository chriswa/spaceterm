/**
 * What was dictated hands-free, as Control should get it: the wake word off
 * the front, punctuation and case around it ignored. Empty when nothing else
 * was said.
 */
export function cleanHandsFreeText(text: string, trigger = 'control'): string {
  const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.trim().replace(new RegExp(`^${escaped}\\b[\\s,.!?:;…—–-]*`, 'i'), '').trim()
}
