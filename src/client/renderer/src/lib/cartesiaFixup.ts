/**
 * Pronunciation-focused transforms applied AFTER cleanTerminalCopy on text
 * sent to Cartesia TTS. cleanTerminalCopy handles structural cleanup
 * (paragraph reflow, marker prefix removal, dedent); cartesiaFixup patches
 * specific things Cartesia mispronounces.
 *
 * Add a new rule by adding a fixture in cartesiaFixup.test.ts first — see
 * .claude/skills/cartesia-fixup/.
 */
export function cartesiaFixup(text: string): string {
  let out = text

  // 1. snake_case → space-separated. Replace `_` only when it sits between
  //    two letters/digits — NOT next to another underscore — so leading,
  //    trailing, and doubled underscores (e.g. Python `__init__`, `_private`)
  //    survive intact rather than turning into stray spaces.
  out = out.replace(/(?<=[a-zA-Z0-9])_(?=[a-zA-Z0-9])/g, ' ')

  // 2. camelCase / PascalCase → space-separated. Insert a space whenever a
  //    lowercase letter or digit is immediately followed by an uppercase
  //    letter. Does not split runs of consecutive uppercase letters (e.g.
  //    `HTTPserver` stays put — those would be handled by an explicit
  //    acronym-list rule if/when needed).
  out = out.replace(/([a-z0-9])([A-Z])/g, '$1 $2')

  // 3. ".ts" file extension → " dot T S". `\b` keeps `.tsx`, `.tsv`, etc.
  //    untouched. Runs after the camelCase split so `cleanTerminalCopy.ts`
  //    becomes `clean Terminal Copy dot T S`.
  out = out.replace(/\.ts\b/g, ' dot T S')

  // 4. ALL-CAPS words of length ≥ 2 → lowercase. Without this, Cartesia
  //    spells out caps-runs ("FEATURE" → "F E toor"). Trade-off: real
  //    acronyms (URL, HTTP, etc.) also get lowercased; add an explicit
  //    acronym rule if a specific one needs to stay spelled out.
  out = out.replace(/\b[A-Z]{2,}\b/g, m => m.toLowerCase())

  return out
}
