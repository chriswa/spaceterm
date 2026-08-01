# Next Steps

Working notes for whoever picks this up next. See `MODDING.md` for the separate
question of turning features into mods.

## Where things stand

| | Three sessions ago | Two ago | Last | Now |
|---|---|---|---|---|
| `npm run typecheck` | did not exist | 0 errors | 0 errors, all of `src/` | 0 errors |
| Tests | 89, hand-rolled | 331 | 641 | **984** |
| Test files | 5 | 18 | 31 | **46** |
| Vitest projects | 1 (node) | 1 | 1 | **2 (node + jsdom)** |
| Tier 0 registries | none | none | 1 of 3 | **3 of 3** |
| Versioned sockets | 0 | 0 | 1 of 2 | **2 of 2** |
| `server/index.ts` | 3061 | 3087 | 3007 | **2478** |
| `Toolbar.tsx` | 1021 | 1021 | 1021 | **40** |

All three of MODDING.md's Tier 0 registries now exist — `AgentDriver`,
`CardType`, `ToolbarWidget` — and every first-party feature goes through them.
All four preconditions for a mod API are met.

## What the last session did

Fourteen commits, each self-contained. `git log` carries the reasoning.

**Extractions from `index.ts`** (3007 → 2478): `gh-rate-limit.ts` (the sparkline
poller, 24 tests), `script-api.ts` (the mod API, 45 tests), `resume-target.ts`
(which agent session to resume, 31 tests), `terminal-respawn.ts` (six
hand-written copies of an order-sensitive sequence collapsed to one),
`restart-recovery.ts` (the last lifecycle state outside a tested module).

**`ToolbarWidget` registry** — the last of MODDING.md's Tier 0. `Toolbar.tsx`
went from 1021 lines to 40 and its four unrelated tenants became four files.

**Contracts.** The client socket is now versioned (`client-hello`), and both
sockets share one `checkProtocolVersion`. `NodeAlert.type` is a closed union.
`StateManager.createTerminal` takes a named spec instead of eleven positional
parameters. Parent-chain walking has one cycle-guarded implementation instead
of four.

**Productization.** `capabilities.ts` probes optional integrations at startup
and says what each missing one costs; `spaceterm-cli capabilities` makes the
same report reachable without a running server. The README now says what
Spaceterm is *for*, and documents the four platform dependencies rather than
just saying "macOS".

**Reliability.** A generated-graph round-trip test for `state.json`. Launch
failures now leave a `launch-failed` alert on the surface rather than a toast
that disappears.

### What the seams found this time

The pattern from previous sessions held: **every seam added turned up a
defect.**

- The capability probe ran `pgrep` with a non-matching pattern and read its exit
  code. pgrep exits 1 when nothing matches, so it reported a working pgrep as
  missing — **wrong on the very first machine it ran on**. Presence and exit
  code are different questions and the deps interface now offers both.
- Walking node ancestors for a script did not seed its cycle-guard with the
  starting node, so a `parentId` cycle back through the start listed that node
  as its own ancestor. It terminated; it just answered wrong.
- `checkProtocolVersion` inlined in two places let **NaN through**. A naive
  `theirs >= min && theirs <= max` is false for NaN, so `!(too old) && !(too
  new)` reads as compatible — and the number arrives over a socket from code we
  did not write.
- `script-api.test.ts` typechecked only because vitest strips types — `id`
  appeared twice in the same object literal. **`npm test` passing is not
  evidence that a test file typechecks.** Run both.
- The toolbar registry's first draft keyed mapped widgets with a
  `display: contents` wrapper span. `.toolbar__zoom > :last-child` selects the
  last *element*, and a wrapper wins that match even at `display: contents` —
  and would match even when the widget inside renders nothing, which the
  rate-limit meter does whenever `gh` is unavailable. A keyed `Fragment` adds
  no element.
- `spaceterm-cli capabilities` exited non-zero on any missing capability, which
  reports a healthy machine as broken: "PTY daemon socket — not yet started,
  normal on a cold boot" is an *expected* absence. Same cry-wolf mistake as the
  pgrep probe, caught this time before it shipped.

## The rule that produced all of the above

If a module cannot be tested without reaching into `fs`, `child_process`, or a
timer, **adding the seam is the deliverable**. Not a mock. Written up in
CLAUDE.md under "Testing", and every module extracted so far follows the same
shape: a narrow deps interface with the real implementation as the default.

Three corollaries worth stating, all learned the hard way:

- **Type-level assertions have to be checked by breaking them.** Two separate
  attempts at a compile-time registry cross-check reported nothing:
  `T extends U ? true : never` in a tuple position is a legal type, and
  `MutuallyAssignable<A extends B, B extends A>` is a circular-constraint error
  rather than an assignment error. The version that works is two one-way
  `Assignable<Sub extends Super, Super>` aliases — verified by adding a node
  type with no spec and watching it fail.
- **The same goes for tests.** `module-cycles.test.ts` was written to catch a
  specific import cycle and passed *against that exact cycle*, because its
  regex used `[^'"\n]*?` and so skipped every multi-line import. Reintroduce the
  bug and watch the test go red, or you have not written a test.
- **A diagnostic that cries wolf is worse than no diagnostic.** Twice now, a
  probe reported a healthy machine as broken — `pgrep` exiting 1 on no match,
  and `capabilities` exiting non-zero on an expected cold-boot absence. Before
  adding a check, ask what a *correct* system looks like to it.

## What is left

### Tier C — extract before testing

- **`server/index.ts`** (2478, down from 3087). Five tenants have moved out
  (`agent-provisioning`, `gh-rate-limit`, `script-api`, `resume-target`,
  `restart-recovery`). What remains is `handleMessage` — a ~990-line switch over
  49 client message types — plus socket setup plus startup reconciliation.
  Those are three files.

  The switch is not uniformly bad: 30 of the 49 cases are under 20 lines and
  read fine as a router. The value is in the nine that are not
  (`terminal-restart` 93, `fork-session` 85, `node-unarchive` 68, `attach` 57,
  `directory-wt-spawn` 52). Those are operations, not routing, and the
  fork/spawn ones now have `respawnTerminal` and `NewTerminalSpec` to build on.
  A `terminal-operations.ts` holding create/fork/restart/reincarnate/unarchive
  would take ~350 lines out and be the first testable coverage of the terminal
  lifecycle above the session-manager level. **Note the shape of the problem:**
  these operations need the requesting client (to reply, to auto-attach), so
  the extraction needs a small reply abstraction the way `ScriptApi` needed
  `ScriptConnection`. That is the design question to answer first.
- **`state-manager.ts`** (1131). Both original tenants are out and the mutate →
  broadcast → persist triples are now `patchNode`/`applyPatch`. What is left
  really is state management; the open question is whether it needs splitting at
  all rather than where to cut.
- **`App.tsx`** (2426) and **`TerminalCard.tsx`** (1248) — now the largest files
  in the repo. The keyboard handler's *decisions* are extracted
  (`lib/keyboard.ts`); its 340 remaining lines are effects that need App's
  state. `TerminalCard`'s 466-line xterm mount effect is untouched, as are the
  four module-level `Map`s it exports as an imperative side-channel for App —
  extract the handler's effects and that escape hatch disappears on its own.
  **There is now a jsdom vitest project**, so a renderer test needs no config
  work first.

### Card component unification — deliberately deferred

`App.tsx` maps five near-identical card lists. `CardType` made the *data* side
one registry, but the components take ~30 differing props each and cannot be
verified without running the GUI, which an agent cannot do here (see "Things
deliberately not done"). Do this one at a keyboard, with the app running.

## Ideas for the next sessions

Not backlog items with agreed shapes — the things that would most improve the
software, roughly ordered by value per unit of risk. Struck-through entries were
done last session; kept so the reasoning is not lost.

### Reliability

1. ~~**The client socket is unversioned.**~~ Done. `client-hello` mirrors
   `script-hello`, and both now share one `checkProtocolVersion`.
2. **No integration test spans the whole server.** `session-manager.test.ts`
   drives the fake daemon, but nothing exercises `startServer` →
   reconciliation → a client connecting → a terminal spawning. Every piece
   needed now exists (`fake-daemon.ts`, `FakePersistenceIO`, `ScriptApi` with a
   fake connection, `respawnTerminal` with injectable deps); what is missing is
   `startServer` being callable with injected collaborators rather than
   constructing its own. **This is the single highest-value remaining item.**
3. **Startup reconciliation is the least-tested, highest-consequence code in
   the repo.** It decides, per node, whether to reattach, revive, or archive —
   and it runs before anyone is watching. Everything it depends on is now behind
   a seam (`respawnTerminal`, `resume-target`, `StatePersister`); only its own
   structure is left.
4. ~~**Nothing verifies that a persisted state file round-trips.**~~ Done, over
   generated graphs. It also turned the ephemeral-field strip from a magic
   string into `EPHEMERAL_STATE_FIELDS`.
5. **The hooks/ingest socket has no version and no handshake.** Both other
   sockets now do. This one's producers are shell scripts spaceterm itself
   provisions, so it is genuinely lower risk — but that is an argument about
   *who* speaks it, not about whether it can drift, and a mod that installs its
   own hook handler changes the answer.

### Robustness

6. ~~**`restartRecovery` is a module-level Map with a wall-clock window.**~~
   Done — `RestartRecoveryLedger`, 20 tests, `now` injected.
7. ~~**Error surfacing is one-way.**~~ Done for launch failures: a restart or
   revive that fails now leaves a `launch-failed` alert on the surface. The same
   treatment is worth applying to a failed `directory-wt-spawn` and to a
   summary-chat error, both of which are still toast-only.
8. ~~**Unbounded graph walks.**~~ Checked: all four were already cycle-guarded.
   They are now *one* guarded walk (`shared/node-ancestry.ts`) rather than four
   copies, which is what removes the chance of the next one being written
   without a guard.
9. **`SummaryChat` and the pollers all own their own retry policy.** Three
   different backoff shapes, none shared. Not urgent, but it is the same
   many-copies-of-one-decision signature that produced `terminal-respawn.ts`.

### Productization — supporting users who are not the author

10. ~~**Make the capability report reachable.**~~ Half done:
    `spaceterm-cli capabilities` exists and the report goes to the log. The
    remaining half is the one that matters most — showing it **in the UI, next
    to the button that does nothing**. The data is already structured
    (`id`/`name`/`available`/`detail`/`affects`) for exactly that; what is
    needed is a protocol message and a place to put it.
11. ~~**Document the platform coupling.**~~ Done in the README, with the table.
    The port itself is still open, and is smaller than "macOS only" suggests:
    terminals, the canvas, agent state, git status, fork and resume have no
    platform-specific dependency at all.
12. **There is still no first-run path.** `capabilities` is the seed of a
    `spaceterm doctor`, but nothing checks that the agent CLIs on PATH are the
    ones the drivers expect, or that `~/.spaceterm/` is writable, or that the
    Go daemon binary matches the source. A first run that fails currently fails
    silently in four different places.
13. **Incremental adoption has no on-ramp.** Every feature is on. A user who
    wants a canvas of terminals also gets hook provisioning into `~/.cursor/`
    and `~/.codex/`, background-work probing, and a speech integration. The
    provisioning half is behind `AgentProvisioning` already; a settings surface
    that can decline it is mostly wiring, and the honest first step is a config
    file rather than UI.
14. ~~**Nothing documented for a reader outside the code.**~~ Done — the README
    now opens with what Spaceterm is for and who it is not for.

### Extensibility

15. See MODDING.md. Tier 0 is complete and all four contract preconditions are
    met, so the next real step is the mod *lifecycle* — manifest, spawn, health,
    restart-on-crash, disable — not more contract work.
16. **Per-connection `ScriptHost`.** Today every connected script gets every
    capability. A manifest's "what it may call" only means something if the host
    handed to a mod's connection is a subset. `ScriptApi` takes its host by
    constructor injection, so this is a per-connection host rather than a
    rewrite. It is blast-radius reduction, not security — see MODDING.md.
17. **The three registries are still const arrays.** Making each mutable with a
    `register()` is a small change that should be made *when the first mod needs
    it* and not before — a registry nobody registers into is just a slower
    array.
18. **A declarative widget contract** is the cheapest route to Tier 2. A mod
    supplies data over the scripts socket and picks from renderers spaceterm
    already has (a metric, a sparkline, a toggle). `DeltaSparkline` is already
    generic over any minute-keyed monotonic series precisely so this is
    possible, and nine of fourteen toolbar widgets already satisfy the
    standalone contract.

## Things deliberately not done

- **`session-title-summarizer.ts` has no seam.** It is hard-disabled at
  `const ENABLED = Boolean(false)`. Add the seam when it is turned back on.
- **No UTF-8 sanitizer.** The ESC-eats-the-escape defect does not reproduce
  against current xterm.js — tested by driving `@xterm/headless` with the exact
  bytes rather than assumed. See the rewritten `Potential UTF Bug Fix.md`. The
  investigation found a real bug next door instead (Unicode 6.0 vs 11.0 width
  tables between the snapshot and visible terminals), which is fixed.
- **`--ignore-scripts`** in the hook and CI still skips `electron-rebuild` and
  Electron's binary download. Fine for typecheck/lint/test; an agent cannot
  launch the GUI without a full `npm install`. This is why anything requiring
  visual verification is deferred rather than attempted.
- **xterm / WebGL / canvas rendering** will not test meaningfully in jsdom.
  `snapshot-manager.test.ts` shows the workable middle ground: `@xterm/headless`
  runs fine in node, so the serialization path *is* tested; only pixels are left
  to manual verification.
