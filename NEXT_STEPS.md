# Next Steps

Working notes for whoever picks this up next. See `MODDING.md` for the separate
question of turning features into mods.

## Where things stand

| | Two sessions ago | Last session | Now |
|---|---|---|---|
| `npm run typecheck` | did not exist | 0 errors | 0 errors, and now covers `src/cli` and `src/claude-code-plugin` too |
| Tests | 89, hand-rolled | 331 | 604 |
| Test files | 5 | 18 | 30 |
| Exhaustiveness checks | none | none | all four message switches |
| State migrations | none | none | versioned pipeline |
| Identifier types | plain `string` | plain `string` | branded |

Every `.ts` file under `src/` is now typechecked. Both prior gaps — the CLI and
the MCP server that `MODDING.md` calls spaceterm's first mod — were already
clean; nothing had been checking them.

## What the last session did, and what it found

Eleven commits, each self-contained. `git log` carries the reasoning; the short
version is that **every seam added turned up a real defect**, which is the
argument for adding the rest.

- **`persistence.ts` → `StatePersister`.** The debounce timer was module-scoped,
  so two `StateManager`s cancelled each other's writes — and no test could
  construct one without writing to the developer's real `state.json`. This was
  the blocker for all of Tier C.
- **Exhaustiveness.** `handleIngestMessage` had no `default` at all; the two
  switches that did reached their discriminant through `(msg as any).type`,
  which defeats narrowing. `ServerClient.handleMessage` was a 20-branch if-chain
  ending in `'seq' in msg`, so a new broadcast would have silently taken the
  response path and been dropped.
- **State migrations.** `STATE_VERSION` was written and never read. The gap
  showed as accumulation: seven ad-hoc backfills, and a `// TEMPORARY:` alert
  wipe that ran on *every* boot because there was no way to say "once".
- **Branded ids.** Caught two live bugs (`surfaceAgentType` and
  `terminal-resize` each using one kind of id as the other) and two mis-typed
  parameters that read as the wrong thing.
- **`SummaryChat`.** Found three: an unbounded poll loop that pinned a CPU
  against a fast-responding service (it OOM'd the test runner on the first run),
  a dead interruption-context feature, and target selection that broke on a
  `Date.now()` tie.
- **`GitStatusPoller`** leaked up to a minute of queued polls past `dispose()`.
  **`SnapshotManager`** had the same `Date.now()` tie in its fairness ordering.
  **`PlanCacheManager`** could overwrite a cached plan version with another
  captured in the same millisecond.
- **`FileContentManager`** declared a `debounceTimer` on each entry, cleared it
  in `stopWatching`, and never assigned it — the real timer was a local, out of
  reach. A debounce in flight survived `stopWatching`, so repointing a file card
  while its old file was being edited flashed the old file's content back a
  moment later.
- **`AgentDriver` registry** — see `MODDING.md`. Verified by differential test:
  1152 launch specs produce byte-identical command lines to the code it
  replaced.

Three of those bugs were the same shape — **a `Date.now()` tie deciding
something that is really a sequence**. If you find another `sort` on a
timestamp, look at it.

## The rule that produced the above

If a module cannot be tested without reaching into `fs`, `child_process`, or a
timer, **adding the seam is the deliverable**. Not a mock. Written up in
CLAUDE.md under "Testing", and every module below follows the same shape:
a narrow deps interface with the real implementation as the default.

## Tier B — cleared

Every module on the original list now has a seam and tests, except one:

- **`session-title-summarizer.ts`** — deliberately skipped. It is hard-disabled
  at `const ENABLED = Boolean(false)`, so a seam buys nothing until it is turned
  back on. Do it then, not before.

## Tier C — extract before testing

Unchanged in shape, but `persistence.ts` no longer blocks it and `state-manager`
now has 34 tests to refactor against.

- **`state-manager.ts`** (1117 LOC, down from 1180). The mutate → broadcast →
  persist triples are now `patchNode` / `applyPatch`, and every `as Partial<X>`
  cast is gone except one justified variance cast inside the helper — so a
  typo'd field, a wrong value type, or a field belonging to a different node
  type are all compile errors now. The constructor is three lines. **The
  remaining tenant is the cwd-mismatch alert engine** (`:1006-1084`): it is
  self-contained, has no business living in the state store, and would be
  straightforward to extract with tests.
- **`server/index.ts`** (3007 LOC, down from 3087). The seven duplicated spawn
  sequences are now one registry call each, so the next target is different:
  the file is now mostly `handleMessage` (a ~900-line switch) plus socket setup
  plus startup reconciliation. Those are three files, not one.
- **`App.tsx`** (2436), **`TerminalCard.tsx`** (1246), **`Toolbar.tsx`** (1021).
  Unchanged. App's 380-line keyboard handler, TerminalCard's 466-line xterm
  mount effect, Toolbar's 416-line `CrabGroup`. `TerminalCard` still exports
  four module-level `Map`s as an imperative side-channel for App's keyboard
  handler; extract the handler and that escape hatch disappears on its own.

## Making it more serious

The original four are done. What is left from that list, and what replaced it:

1. ~~Protocol versioning and exhaustiveness~~ — both done. The scripts socket
   now has `SCRIPT_PROTOCOL_VERSION`, a `script-hello` handshake, and a
   documented `SCRIPT_EVENTS` set that the broadcast helper is typed against.
   The client socket is still unversioned, which is fine while the Electron
   client ships with the server — but that is an assumption, not a guarantee.
2. ~~State migrations~~ — done. `state-migrations.ts`, currently at version 2.
3. ~~Branded identifiers~~ — done.
4. **One owner for surface state.** Untouched. `claudeState`,
   `claudeStatusUnread`, `claudeStatusAsleep`, `claudeContextPercent`,
   `claudeSessionLineCount` still live in *both* `SessionManager`'s in-memory
   session and `StateManager`'s persisted node, hand-synced through `index.ts`.
   Related: `potential_error` is still decided outside the state machine by
   re-entering `setClaudeState`, so one of seven `ClaudeState` values never
   appears in the decision log.
5. **One owner for the PTY byte stream.** Untouched. The ANSI case is fixed; the
   UTF-8 one (`Potential UTF Bug Fix.md`) is not. `title-parser.ts` is the model.

## Things deliberately not done

- **`--ignore-scripts`** in the hook and CI still skips `electron-rebuild` and
  Electron's binary download. Fine for typecheck/lint/test; an agent cannot
  launch the GUI without a full `npm install`.
- **No jsdom project in the Vitest config.** Everything tested today is pure
  logic or a deps-injected class. Add a second project when component tests
  arrive rather than making jsdom the default for the server suites.
- **xterm / WebGL / canvas rendering** will not test meaningfully in jsdom.
  `snapshot-manager.test.ts` shows the workable middle ground: `@xterm/headless`
  runs fine in node, so the serialization path *is* tested; only the pixels are
  left to manual verification.
