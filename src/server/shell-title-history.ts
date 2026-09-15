// Codex puts this animated braille spinner in its OSC title while it is
// working. Versions have placed it both before the title and before a
// workspace suffix. The frame changes independently of the actual title.
const CODEX_TITLE_SPINNER = /(?:^|\s)[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?=\s|$)/g
const CODEX_RENAMING_PLACEHOLDER = /^renaming\.\.\.(?:\s*\|\s*.*)?$/i

export function normalizeShellTitle(title: string): string {
  const normalized = title.replace(CODEX_TITLE_SPINNER, '').replace(/\s{2,}/g, ' ').trim()
  // Codex emits this brief OSC title while replacing it with the generated
  // title. It is status text, not a title worth showing or retaining.
  return CODEX_RENAMING_PLACEHOLDER.test(normalized) ? '' : normalized
}

/** Preserve most-recent-first order while removing transient and duplicate titles. */
export function normalizeShellTitleHistory(history: readonly unknown[]): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const rawTitle of history) {
    if (typeof rawTitle !== 'string') continue
    const title = normalizeShellTitle(rawTitle)
    if (!title || seen.has(title)) continue
    seen.add(title)
    normalized.push(title)
  }
  return normalized
}
