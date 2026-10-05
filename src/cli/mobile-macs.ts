/**
 * Every Mac the phone app should be able to find, and whether this Mac can
 * build an app that knows them all.
 *
 * `src/mobile/ios/macs` (committed) names each Mac by its tailnet host name.
 * `~/.spaceterm/other-macs` (private: it carries tokens) holds the pairing
 * URL of every Mac but this one. A build checks the two against each other and
 * refuses, saying exactly what to fill in, so that an app built on any Mac
 * reaches every Mac — and so that the Mac missing from the list is the one
 * that gets told.
 */

/** Host names from the committed list: one per line, blanks and `#` comments skipped. */
export function parseMacs(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
}

/** The host of a pairing URL (`https://<host>/#token=…`), or null for anything else. */
export function pairingHost(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || !parsed.hash.startsWith('#token=')) return null
    return parsed.hostname
  } catch {
    return null
  }
}

export interface MacsCheck {
  /** Hosts in `src/mobile/ios/macs`. */
  required: string[]
  /** This Mac's tailnet host name. */
  own: string
  /** Lines of `~/.spaceterm/other-macs`. */
  others: string[]
}

/**
 * What stops this Mac building an app that reaches every listed Mac: each a
 * line saying what to fill in and where. Empty means build.
 */
export function macsProblems({ required, own, others }: MacsCheck): string[] {
  const problems: string[] = []
  if (!required.includes(own)) {
    problems.push(`src/mobile/ios/macs does not list this Mac (${own}): add that line and commit it, so apps built elsewhere reach it too`)
  }
  const bad = others.filter((url) => !pairingHost(url))
  for (const url of bad) {
    problems.push(`~/.spaceterm/other-macs has a line that is not a pairing URL (https://<host>/#token=…): ${url}`)
  }
  const known = new Set(others.map(pairingHost).filter((h): h is string => !!h))
  for (const host of required) {
    if (host !== own && !known.has(host)) {
      problems.push(`~/.spaceterm/other-macs is missing ${host}: on that Mac run \`npm run mobile:link -- --url\` and add the printed line here`)
    }
  }
  return problems
}
