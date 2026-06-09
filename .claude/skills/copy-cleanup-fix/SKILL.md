---
name: copy-cleanup-fix
description: Use when the user reports a problem with how copied text from a spaceterm xterm was formatted — e.g. Claude Code's "⏺" prefix not stripped, paragraphs not reflowed into single lines, list items joined together, indentation surviving, or the TTS misreading text that was selected. Captures the user's example as a regression fixture, confirms the desired output, then fixes cleanTerminalCopy until the test passes without regressing prior fixtures.
---

# Copy Cleanup Fix

This skill drives a tight TDD-style workflow for `cleanTerminalCopy`, the transform that runs on text copied from xterm and on text sent to Cartesia TTS.

## Files you will touch

- `src/client/renderer/src/lib/cleanTerminalCopy.ts` — the transform.
- `src/client/renderer/src/lib/cleanTerminalCopy.test.ts` — fixture-based regression tests. Each case is `{ name, input, expected }`.
- Run tests with `npm test`.

## Step 1 — Capture the RAW input

You need the exact bytes the user copied, including every space and unicode character. Two ways:

1. **Preferred**: ask the user to toggle the **Copy Cleanup** broom button in the toolbar OFF, re-select the same xterm text, copy it, and paste it back to you. This bypasses `cleanTerminalCopy` and gives the true raw xterm selection.
2. If the user has already pasted something but it might already have been cleaned, ask them to recapture it with the toggle off.

When you receive the paste, preserve **every leading and trailing space** and any unicode markers (`⏺`, `❯`, box-drawing chars, etc.). When you put the input into the test fixture as a template literal, do not normalise whitespace.

## Step 2 — Confirm the desired output

Before writing any test or code, ask the user explicitly:

> "Here's what I captured as the raw input: ⟨quote it back⟩. What should `cleanTerminalCopy` turn this into?"

Get the expected output line-by-line if there is any ambiguity. Surface any edge cases you notice (trailing punctuation, list items, code-like indentation) and ask. **Do not guess** — a wrong expected value pushes the fix in the wrong direction and corrupts the regression suite.

## Step 3 — Add the fixture

Append a new entry to the `cases` array in `cleanTerminalCopy.test.ts`:

```ts
{
  name: 'short description of the scenario',
  input:
`...raw text exactly as captured, in a template literal...`,
  expected:
`...the user-confirmed desired output...`,
},
```

Keep `name` short and descriptive. Place the new case alongside related ones if a natural grouping exists.

## Step 4 — Run the tests

```bash
npm test
```

Confirm the new case fails (and that it fails in a way that matches the user's complaint). If unrelated cases also fail, note them — they may be pre-existing failures, or your edit accidentally changed shared whitespace.

## Step 5 — Fix `cleanTerminalCopy`

Edit `src/client/renderer/src/lib/cleanTerminalCopy.ts` until `npm test` is fully green. Common ingredients you may need:

- **Prefix detection**: generalize beyond hard-coded `⏺ `. Likely a single non-alphanumeric char followed by a space, gated by an indent-consistency check on subsequent lines.
- **Dedent**: strip the common indent from continuation lines.
- **Soft-wrap join**: join adjacent non-blank lines into one when the second line is *not* a structural marker (numbered list `^\d+[.)]\s`, bullet `^[-*•+]\s`, heading `^#+\s`, code fence ` ``` `, blockquote `^>\s`, table row `^\|`).
- **Code-block protection**: 4+ leading spaces after dedent, or inside a ` ``` ` fence → preserve line breaks.

**Critical**: every existing fixture must still pass. The whole point of the suite is to lock in previous bug fixes.

## Step 6 — Verify and stop

Once `npm test` is green:

1. Summarize the fix in 1–2 sentences (what changed in the algorithm + which fixtures now pass).
2. Ask the user to verify in the live app: toggle the broom ON, re-copy the original text, confirm the clipboard contents match what they wanted.
3. Only after they confirm should you stop.

## Anti-patterns to avoid

- **Don't guess at the expected output.** Always pull it from the user.
- **Don't tweak only the failing case.** If you find yourself special-casing the exact input string, the algorithm is wrong. Step back and find the generalisation.
- **Don't delete or alter prior fixtures** to make the tests pass. Those represent decisions the user already made. If a prior fixture conflicts with a new requirement, surface the conflict to the user and ask them to resolve it.
- **Don't run `cleanTerminalCopy` on already-cleaned input** when building a fixture. The transform must see the raw xterm selection. If unsure, confirm with the user.
