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

  // 3. ".ts" file extension → " dot T. S." (with trailing periods per the
  //    spelled-out-letter convention — see spellOut). `\b` keeps `.tsx`,
  //    `.tsv`, etc. untouched. Runs after the camelCase split so
  //    `cleanTerminalCopy.ts` becomes `clean Terminal Copy dot T. S.`.
  out = out.replace(/\.ts\b/g, ' dot T. S.')

  // 4. ALL-CAPS words: decide between pronouncing (lowercase) and spelling
  //    out (space-separated letters) using a small phonotactic heuristic +
  //    two override lists. Cartesia tends to spell out caps runs ("FEATURE"
  //    → "F E toor", "TTS" → lowercase "tts" → "teets") so we have to take
  //    a side on each word.
  out = out.replace(/\b[A-Z]{2,}\b/g, transformAllCapsWord)

  return out
}

// Override lists for the ALL-CAPS pass. Use Sets of UPPERCASE keys.
//
// Add a fixture in cartesiaFixup.test.ts FIRST when extending these — see
// .claude/skills/cartesia-fixup/.
const FORCE_PRONOUNCE = new Set<string>([
  'URL', // looks like an acronym, but read as one syllable ("earl") sounds better.
])
const FORCE_SPELL_OUT = new Set<string>([
  // Empty for now — the heuristic correctly spells out API/IDE/OS/TTS/etc.
])

// 3-letter words we accept as pronounceable: either consonant-vowel-consonant
// (CVC: gap, bar, bus, log, max) or vowel-vowel-consonant (VVC: out, aim,
// ear, oar). Both end in a consonant — the closing consonant is the strong
// signal that this is one syllable.
//
// We deliberately don't include VCV (api, ide, usa, fbi-like) or VCC (abc,
// ant) — those patterns hit too many acronyms even though they catch some
// real words. Add real-word exceptions to FORCE_PRONOUNCE when they come up.
// Y is treated as a consonant; SKY/etc. fall through to spell-out.
const PRONOUNCEABLE_3LETTER =
  /^([BCDFGHJKLMNPQRSTVWXYZ][AEIOU]|[AEIOU][AEIOU])[BCDFGHJKLMNPQRSTVWXYZ]$/

function isPronounceable(word: string): boolean {
  if (!/[AEIOU]/.test(word)) return false // no vowel → can't be a syllable
  if (word.length >= 4) return true
  if (word.length === 3) return PRONOUNCEABLE_3LETTER.test(word)
  return false // 2-letter ALL-CAPS: spell out by default (OK → "O. K.")
}

function spellOut(word: string): string {
  // Trailing periods after each letter force Cartesia to pause between them
  // instead of running them together as a fake syllable. "T T S" gets slurred;
  // "T. T. S." is read as three distinct letters.
  return word.split('').map(c => c + '.').join(' ')
}

function transformAllCapsWord(word: string): string {
  if (FORCE_PRONOUNCE.has(word)) return word.toLowerCase()
  if (FORCE_SPELL_OUT.has(word)) return spellOut(word)
  return isPronounceable(word) ? word.toLowerCase() : spellOut(word)
}
