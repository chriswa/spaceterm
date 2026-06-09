import { cartesiaFixup } from './cartesiaFixup'

/**
 * Regression fixtures for cartesiaFixup — pronunciation tweaks applied to
 * text routed to Cartesia TTS AFTER cleanTerminalCopy. Each case captures a
 * real Cartesia mispronunciation plus the desired rewrite.
 *
 * To add a new case when the user reports a TTS pronunciation bug, follow
 * .claude/skills/cartesia-fixup/. Decide first whether the fix belongs in
 * cleanTerminalCopy (structural) or here (pronunciation).
 *
 * Run with: npm test
 */

interface Case {
  name: string
  input: string
  expected: string
}

const cases: Case[] = [
  {
    name: 'empty string',
    input: '',
    expected: '',
  },

  {
    name: 'plain text without triggers passes through',
    input: 'the quick brown fox jumps over the lazy dog',
    expected: 'the quick brown fox jumps over the lazy dog',
  },

  // -- ".ts" filepath rule -------------------------------------------------
  // Cartesia reads ".ts" as "dot tess" — rewrite to "dot T S".

  {
    name: 'single .ts filename at end of word',
    input: 'open foo.ts',
    expected: 'open foo dot T S',
  },

  {
    name: '.ts filename followed by sentence-end punctuation',
    input: 'Update foo.ts.',
    expected: 'Update foo dot T S.',
  },

  {
    name: '.ts filename inside a path (with camelCase split applied first)',
    input: 'src/client/renderer/src/lib/cleanTerminalCopy.ts',
    expected: 'src/client/renderer/src/lib/clean Terminal Copy dot T S',
  },

  {
    name: '.ts followed by colon (file:line)',
    input: 'foo.ts:42',
    expected: 'foo dot T S:42',
  },

  {
    name: 'multiple .ts occurrences in one sentence',
    input: 'edit foo.ts then bar.ts and baz.ts',
    expected: 'edit foo dot T S then bar dot T S and baz dot T S',
  },

  {
    name: '.tsx is left alone',
    input: 'Component.tsx renders',
    expected: 'Component.tsx renders',
  },

  {
    name: '.tsv is left alone',
    input: 'data.tsv has 100 rows',
    expected: 'data.tsv has 100 rows',
  },

  // -- camelCase split -----------------------------------------------------
  // Insert space at lowercase/digit → uppercase boundary.

  {
    name: 'camelCase identifier splits into words',
    input: 'cleanTerminalCopy',
    expected: 'clean Terminal Copy',
  },

  {
    name: 'PascalCase identifier splits (no leading split)',
    input: 'TerminalCard renders fine',
    expected: 'Terminal Card renders fine',
  },

  {
    name: 'camelCase inside a sentence',
    input: 'the speakText function queues utterances',
    expected: 'the speak Text function queues utterances',
  },

  {
    name: 'single-word PascalCase has nothing to split',
    input: 'Component',
    expected: 'Component',
  },

  // -- snake_case split ----------------------------------------------------
  // Replace internal underscores with spaces, then ALL-CAPS rule lowercases.

  {
    name: 'YELLING_SNAKE_CASE splits and lowercases',
    input: 'INTER_UTTERANCE_GAP_MS',
    expected: 'inter utterance gap ms',
  },

  {
    name: 'lowercase snake_case splits',
    input: 'my_function_name',
    expected: 'my function name',
  },

  {
    name: 'snake_case inside a sentence',
    input: 'set MAX_RETRIES = 3 today',
    expected: 'set max retries = 3 today',
  },

  {
    name: 'leading underscore preserved (Python _private)',
    input: '_private',
    expected: '_private',
  },

  {
    name: 'dunder identifier preserved (__init__)',
    input: '__init__',
    expected: '__init__',
  },

  // -- ALL-CAPS lowercase --------------------------------------------------
  // Cartesia spells out runs of capitals. Lowercase 2+-char ALL-CAPS words.

  {
    name: 'standalone ALL-CAPS word lowercased',
    input: 'FEATURE',
    expected: 'feature',
  },

  {
    name: 'ALL-CAPS label inside a sentence',
    input: 'FEATURE: added a thing',
    expected: 'feature: added a thing',
  },

  {
    name: 'multiple ALL-CAPS words in a sentence',
    input: 'IDEAS and CAVEATS were captured',
    expected: 'ideas and caveats were captured',
  },

  // -- ALL-CAPS negative cases --------------------------------------------

  {
    name: 'single-letter "I" stays uppercase (length guard)',
    input: 'I am here',
    expected: 'I am here',
  },

  {
    name: 'mixed-case word with leading capital is untouched',
    input: 'Hello World',
    expected: 'Hello World',
  },

  {
    name: 'numbers untouched',
    input: 'value is 1234',
    expected: 'value is 1234',
  },

  // -- Combined rules ------------------------------------------------------

  {
    name: 'camelCase identifier in a path with .ts',
    input: 'src/lib/cleanTerminalCopy.ts',
    expected: 'src/lib/clean Terminal Copy dot T S',
  },

  {
    name: 'mixed camelCase and ALL-CAPS snake in one sentence',
    input: 'set MAX_RETRIES on the httpClient instance',
    expected: 'set max retries on the http Client instance',
  },
]

let failed = 0
for (const c of cases) {
  const actual = cartesiaFixup(c.input)
  if (actual === c.expected) {
    console.log(`✓ ${c.name}`)
    continue
  }
  failed++
  console.log(`✗ ${c.name}`)
  console.log(`  got: ${JSON.stringify(actual)}`)
  console.log(`  exp: ${JSON.stringify(c.expected)}`)
  console.log('')
}

if (failed > 0) {
  console.log(`\n${failed}/${cases.length} cases failed`)
  process.exit(1)
}
console.log(`\nall ${cases.length} cases passed`)
