import { cleanTerminalCopy } from './cleanTerminalCopy'

/**
 * Regression fixtures for cleanTerminalCopy. Each case captures a real
 * user-reported copy-from-xterm scenario plus the desired cleaned output.
 *
 * To add a new case when the user reports a copy-formatting bug, follow the
 * `copy-cleanup-fix` skill in .claude/skills/copy-cleanup-fix/. Use the
 * Copy Cleanup toolbar toggle (broom icon) to capture the RAW selection.
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
    name: 'single line, no marker prefix',
    input: 'just one line',
    expected: 'just one line',
  },

  {
    name: 'Claude Code ⏺ prefix with indented continuation',
    input:
`⏺ First line of output.
  Second line continues.
  Third line continues.`,
    expected:
`First line of output. Second line continues. Third line continues.`,
  },

  // From the user's very first prompt this session. ❯ prefix with 2-space
  // indent continuation, plus a stray 3-space soft-wrap line ("kind\n of").
  // Two paragraphs separated by a blank line, each should reflow to one line.
  {
    name: '❯ prompt prefix, two prose paragraphs with soft-wrap-on-space',
    input:
`❯ We currently have some special code which is supposed to automatically format selected text when I copy it from Claude code inside of an extern. It's
  supposed to collapse down indented text so that it's all on the same line, etc. This is also a concern with the Cartesia text-to-speech system, which is kind
   of a parallel concern. It's a little similar. The Cartesia text-to-speech system does some processing on selected text as well. It adds some punctuation to
  the ends of lines to make sure that there are correct pauses.

  What I think we should do is have the first system, let's call it the copy cleanup system, run first for both; then we'll have the Cartesia text-to-speech
  transform happen afterwards to add punctuation and fix other issues which we'll get to later. For now, we need the system to be improved. Currently, when I
  select indented text, it ends up getting just crammed on separate lines, and when there are adjacent lines, I don't want that to happen. I'll give you some
  examples as we go along, but for now I want you to find the relevant systems and to rewire the Cartesia stuff to go through the same copy cleanup system.`,
    expected:
`We currently have some special code which is supposed to automatically format selected text when I copy it from Claude code inside of an extern. It's supposed to collapse down indented text so that it's all on the same line, etc. This is also a concern with the Cartesia text-to-speech system, which is kind of a parallel concern. It's a little similar. The Cartesia text-to-speech system does some processing on selected text as well. It adds some punctuation to the ends of lines to make sure that there are correct pauses.

What I think we should do is have the first system, let's call it the copy cleanup system, run first for both; then we'll have the Cartesia text-to-speech transform happen afterwards to add punctuation and fix other issues which we'll get to later. For now, we need the system to be improved. Currently, when I select indented text, it ends up getting just crammed on separate lines, and when there are adjacent lines, I don't want that to happen. I'll give you some examples as we go along, but for now I want you to find the relevant systems and to rewire the Cartesia stuff to go through the same copy cleanup system.`,
  },

  // User selected the indented continuation portion of a Claude `⏺ ` paragraph
  // without including the `⏺` line itself. Both lines start with 2 spaces; the
  // line break is just a soft wrap and should collapse to a single line.
  {
    name: 'indented prose continuation, no marker, single soft-wrap',
    input:
`  The skill also lists the algorithm building blocks (prefix detection, dedent, soft-wrap join with structural-marker exceptions, code-block protection) and
  anti-patterns (don't guess expected, don't special-case the failing input, don't mutate prior fixtures).`,
    expected:
`The skill also lists the algorithm building blocks (prefix detection, dedent, soft-wrap join with structural-marker exceptions, code-block protection) and anti-patterns (don't guess expected, don't special-case the failing input, don't mutate prior fixtures).`,
  },

  // From the user's second example: an assistant response containing a
  // numbered list where item 3 soft-wraps to a continuation line at column 0.
  // List markers (1./2./3.) must remain on separate lines; only item 3's wrap
  // should join.
  {
    name: 'numbered list with item 3 soft-wrap, no prefix',
    input:
`I have what I need. Plan:

1. Extract cleanTerminalCopy from TerminalCard.tsx into a new shared module src/client/renderer/src/lib/cleanTerminalCopy.ts.
2. Update TerminalCard.tsx to import from there.
3. Update tts-player.ts:speakText to run cleanTerminalCopy on the input before sending to the cartesia subprocess. Cartesia-specific punctuation transforms
will layer on top later.

Both call sites of speakText (the useTTS hook for selection and server-sync.ts for the spaceterm-speak CLI) will benefit automatically.`,
    expected:
`I have what I need. Plan:

1. Extract cleanTerminalCopy from TerminalCard.tsx into a new shared module src/client/renderer/src/lib/cleanTerminalCopy.ts.
2. Update TerminalCard.tsx to import from there.
3. Update tts-player.ts:speakText to run cleanTerminalCopy on the input before sending to the cartesia subprocess. Cartesia-specific punctuation transforms will layer on top later.

Both call sites of speakText (the useTTS hook for selection and server-sync.ts for the spaceterm-speak CLI) will benefit automatically.`,
  },
]

let failed = 0
for (const c of cases) {
  const actual = cleanTerminalCopy(c.input)
  if (actual === c.expected) {
    console.log(`✓ ${c.name}`)
    continue
  }
  failed++
  console.log(`✗ ${c.name}`)
  const aLines = actual.split('\n')
  const eLines = c.expected.split('\n')
  const max = Math.max(aLines.length, eLines.length)
  console.log(`  diff (actual vs expected), line by line:`)
  for (let i = 0; i < max; i++) {
    const a = i < aLines.length ? aLines[i] : '<missing>'
    const e = i < eLines.length ? eLines[i] : '<missing>'
    const mark = a === e ? ' ' : '!'
    console.log(`  ${mark} L${i + 1} got: ${JSON.stringify(a)}`)
    console.log(`  ${mark} L${i + 1} exp: ${JSON.stringify(e)}`)
  }
  console.log('')
}

if (failed > 0) {
  console.log(`\n${failed}/${cases.length} cases failed`)
  process.exit(1)
}
console.log(`\nall ${cases.length} cases passed`)
