---
name: cartesia-fixup
description: Use when the user reports that Cartesia text-to-speech mispronounced, misread, or awkwardly handled something — e.g. ".ts" read as "dot tess", abbreviations spelled out wrong, punctuation read aloud, code fragments butchered. Decides whether the fix belongs in cleanTerminalCopy (structural) or cartesiaFixup (pronunciation), captures a regression fixture, and adds the transform.
---

# Cartesia Fixup

This skill drives a TDD-style fix workflow for Cartesia TTS quality issues — text that came out sounding wrong when spoken aloud.

## Pipeline architecture

Text routed to Cartesia (e.g. via cmd+shift+s or the spaceterm-speak CLI) passes through TWO transforms in `tts-player.ts:speakText`, in order:

1. **`cleanTerminalCopy`** — structural cleanup (paragraph reflow, marker prefix strip, dedent, soft-wrap join). Shared with the clipboard copy path. Tested in `cleanTerminalCopy.test.ts`. See the `copy-cleanup-fix` skill for its own workflow.
2. **`cartesiaFixup`** — pronunciation tweaks specific to Cartesia. Tested in `cartesiaFixup.test.ts`. Where you'll usually add new rules.

**Important**: the toolbar Copy Cleanup toggle (broom icon) does NOT affect TTS. TTS *always* runs both transforms. The toggle only governs what lands on the system clipboard from an xterm selection.

## Step 1 — Capture the trigger text and the bad pronunciation

You need:
- The EXACT text that was selected when the user triggered TTS (verbatim — every space, every unicode char).
- A description of what Cartesia did wrong (which substring sounded wrong, and what it sounded like).

If the user only has a description, ask them to reproduce by re-selecting the same text and triggering TTS, then paste you the selection.

## Step 2 — Decide: copy cleanup, or cartesia fixup?

This is the most important step. Before changing any code, work out which transform is responsible.

Read both `src/client/renderer/src/lib/cleanTerminalCopy.ts` and `src/client/renderer/src/lib/cartesiaFixup.ts`. Note the responsibilities:

- **cleanTerminalCopy** owns: paragraph reflow, indent stripping, marker prefix removal (`⏺ `, `❯ `, etc.), blank-line preservation, structural-block detection (lists, headings, code fences). Anything STRUCTURAL.
- **cartesiaFixup** owns: pronunciation rewrites. Currently covers:
  - `.ts` filenames → ` dot T S` (so Cartesia doesn't say "dot tess"). `.tsx`/`.tsv` untouched.
  - `snake_case` and `YELLING_SNAKE_CASE` → space-separated words. Leading/trailing/doubled underscores (`_private`, `__init__`) preserved.
  - `camelCase` / `PascalCase` → space-separated. Runs of consecutive caps (e.g. `HTTPserver`) are NOT split — add an explicit rule if one comes up.
  - ALL-CAPS words: a phonotactic heuristic decides between lowercase (pronounce as a word) and space-separated letters (spell out), backed by two override lists.
    - Heuristic — **pronounce** if length ≥ 4 with a vowel, OR length = 3 with a consonant-vowel-consonant pattern. Otherwise **spell out**. Examples: `FEATURE`/`LERP`/`JSON`/`GAP`/`BAR` pronounce; `TTS`/`HTTP`/`CSS`/`API`/`IDE`/`OS` spell out.
    - `FORCE_PRONOUNCE` set (override → lowercase): seeded with `URL`. Add when the heuristic spells out something that sounds better as a syllable.
    - `FORCE_SPELL_OUT` set (override → spaced letters): empty by default. Add when the heuristic pronounces something that should be letters (e.g. an acronym that happens to look pronounceable, like a hypothetical `MOON` for an org name).

If the bug is "Cartesia received structurally wrong text" → fix in cleanTerminalCopy. If the bug is "Cartesia received the right text but pronounced it wrong" → fix in cartesiaFixup.

Tie-breaker: would a clipboard user want this same rewrite? Yes → cleanTerminalCopy. No (they'd be annoyed to see "dot T S" in their paste) → cartesiaFixup.

### If the answer is cleanTerminalCopy

Stop, switch to the `copy-cleanup-fix` skill, and follow that workflow instead. Adding the case to both suites is fine if the bug surfaces in both, but the fix should live with copy cleanup.

### If the answer is cartesiaFixup

Continue below.

## Step 3 — Confirm the desired rewrite

Ask the user EXACTLY what `cartesiaFixup` should output for the given input. Don't guess at the spelling, spacing, or punctuation — Cartesia is sensitive to those. Confirm verbatim.

For example: ".ts" → " dot T S" (with leading space, no trailing space). Don't infer; ask.

## Step 4 — Add the fixture

Append a new entry to the `cases` array in `src/client/renderer/src/lib/cartesiaFixup.test.ts`:

```ts
{
  name: 'short description of the scenario',
  input: 'raw input verbatim',
  expected: 'user-confirmed rewrite',
},
```

Include at least one **negative case** for every new rule — an input that LOOKS similar but should NOT trigger the rewrite. For example, when adding `.ts` rewriting, the negative cases for `.tsx` and `.tsv` prevent over-matching.

## Step 5 — Run the tests

```bash
npm test
```

The new case should fail. If a different case fails, you may have broken an existing rule — investigate before continuing.

## Step 6 — Fix `cartesiaFixup`

Edit `src/client/renderer/src/lib/cartesiaFixup.ts` until all cases pass.

- Prefer scoped regexes with word boundaries (`\b`) or explicit lookarounds over broad string substitutions.
- Don't regress prior fixtures. The whole point of the suite is that previously-fixed pronunciations stay fixed.
- If you find yourself special-casing the exact input, the rule is too narrow. Find the general pattern.

## Step 7 — Verify with the user

Once `npm test` is green:

1. Summarise the new rule in one sentence (what pattern matches, what it becomes).
2. Ask the user to re-trigger TTS on the original selection and confirm Cartesia now pronounces it correctly.
3. Only stop after they confirm.

## Anti-patterns to avoid

- **Don't put pronunciation rewrites in cleanTerminalCopy.** Clipboard users don't want " dot T S" in their paste.
- **Don't put structural fixes in cartesiaFixup.** Anything that should also benefit the clipboard belongs upstream.
- **Don't skip the negative case.** A new regex without a negative test is a regression waiting to happen.
- **Don't change `tts-player.ts` to bolt on one-off transforms.** Add them to `cartesiaFixup.ts` so they're covered by the suite.
