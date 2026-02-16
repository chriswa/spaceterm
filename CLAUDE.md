# Spaceterm

## After making changes

Run `npm run lint` after editing files in `src/` to catch use-before-define errors (temporal dead zone bugs with `const`/`useCallback` ordering).

## Parallel agents

Multiple Claude Code agents may be running on this repo at the same time. Files can be modified by other agents mid-conversation. Never assume a file's contents are stable between reads. To revert your own changes, use surgical `Edit` calls (replacing your new text with the original) rather than `git restore` or full-file `Write`, which would clobber work done by other agents.

## Logging

Use the logger at `src/client/main/logger.ts` — never `console.log`/`console.error`. The log file lives at `~/.spaceterm/electron.log`, which the agent can read directly. Logs sent to the Electron terminal console or DevTools console are invisible to the agent and require the human to manually copy them, wasting time.

## Bug fixes and fragile code

After finding or fixing a bug caused by fragile code, do not just patch the symptom. Take the time to improve the design of the surrounding code so that the same class of bug cannot recur. This means addressing the root cause — whether that's tightening types, restructuring control flow, adding invariants, factoring duplicated code out into a function, or simplifying the logic — not just making the failing case work. Try to identify and fix issues the codebase has which made it difficult to find the source of the bug, and made it easy to introduce the bug in the first place.

## When finishing work

When you're ready to stop working on a feature or task, always end your final message with a brief, product-focused sentence summarizing what was implemented. Preface the summary with "FEATURE: " so the user knows it came from this instruction. This helps the user quickly re-orient when context switching between tasks.

## When providing a project plan

At the top of every project plan, before the context section, include a product-centric one-sentence explanation of what the change accomplishes. Preface it with "FEATURE: " so the user knows it came from this instruction. Below the FEATURE line, if there are perceived risks, detrimental side effects, or important caveats to the plan, include a "CAVEATS: " section listing them.
