# Next Steps

Working notes for whoever picks this up next. See `MODDING.md` for the separate
question of turning features into mods.

## Where things stand

| | Three sessions ago | Two ago | Last | Now |
|---|---|---|---|---|
| `npm run typecheck` | did not exist | 0 errors | 0 errors, all of `src/` | 0 errors |
| Tests | 89, hand-rolled | 331 | 641 | **1138 + 16 E2E** |
| Test files | 5 | 18 | 31 | **54** |
| Vitest projects | 1 (node) | 1 | 1 | **3 (node + jsdom + Electron E2E)** |
| Renderer tests | 0 | 0 | 0 | **226** |
| Can launch the GUI headlessly | assumed impossible | assumed impossible | assumed impossible | **yes** |
| Tier 0 registries | none | none | 1 of 3 | **3 of 3** |
| Versioned sockets | 0 | 0 | 1 of 2 | **2 of 2** |
| `server/index.ts` | 3061 | 3087 | 3007 | **2466** |
| `Toolbar.tsx` | 1021 | 1021 | 1021 | **40** |

All three of MODDING.md's Tier 0 registries now exist — `AgentDriver`,
`CardType`, `ToolbarWidget` — and every first-party feature goes through them.
All four preconditions for a mod API are met.

## The premise that was wrong

Every previous session's notes said a headless agent cannot launch the GUI, and
deferred all client-side work on that basis. **It was wrong, by one line.**

`npm install --ignore-scripts` skips two postinstalls that have nothing to do
with each other: `electron-rebuild`, which compiles native modules and does need
a toolchain we lack, and *electron's own*, which downloads a zip. Skipping the
second was never necessary. The binary downloads here in about three seconds
warm, `Xvfb` is present, and the app runs.

`npm run test:e2e` now builds the app and the Go daemon, fetches the binary if
missing, and drives the real thing: 12 tests, ~40 seconds, all passing. Real
Electron, real server, real pty daemon, all three talking to each other. The
session hook fetches the binary automatically, so this is the default rather
than something to remember.

**Do not defer work to "do this at a keyboard" without first checking whether an
E2E or jsdom test would cover it.**

## What the last session did

Twenty commits. `git log` carries the reasoning.

**Testing infrastructure — the headline.** Three vitest projects (`node`,
`renderer`, `e2e`). `FakeBridge` implements the `Api` interface explicitly, so
faking `window.api` is the entire cost of running the real renderer without
Electron. `renderer-purity.test.ts` walks the value-import graph from the
renderer entry and fails if anything reachable needs Node — the invariant that
keeps that possible, previously unguarded. 211 renderer tests where there were
zero.

**Extractions from `index.ts`** (3007 → 2466):
`script-api.ts`, `resume-target.ts`, `terminal-respawn.ts`,
`restart-recovery.ts`, `startup-reconciliation.ts`, `startup-recovery.ts`. The
last of those is driven end to end against an in-memory daemon — real
StateManager, real SessionManager, real DaemonClient, 32 tests.

**`ToolbarWidget` registry** — the last of MODDING.md's Tier 0. `Toolbar.tsx`
went from 1021 lines to 40.

**Contracts.** The client socket is versioned (`client-hello`), and both sockets
share one `checkProtocolVersion`. `NodeAlert.type` is a closed union.
`createTerminal` takes a named spec. Parent-chain walking has one cycle-guarded
implementation instead of four.

**Productization.** `capabilities.ts` plus `spaceterm-cli capabilities`. The
README says what Spaceterm is for and documents the four platform dependencies.

### The bugs the new coverage found

Every layer added turned up a defect the layer below could not see.

- **No server means no window, ever.** `app.whenReady()` awaited
  `client.connect()` before `createWindow()`, and `connect()` retries forever
  rather than rejecting. A first-run user whose server failed got a dock icon
  and nothing else. Found because the E2E harness's first launch hung — the
  reason turned out to be a product bug, not a harness one.
- **A notification sound could stop node updates.** `playUnreadSound()` runs
  *inside* the node-updated handler, before the patch is applied, and
  `playSound` constructed an AudioContext with no guard. Autoplay policy, no
  audio device, or no API at all, and a surface going unread would silently
  stop updating on screen.
- The capability probe read `pgrep`'s exit code; pgrep exits 1 on no match, so
  it reported a working pgrep as missing — **wrong on the very first machine it
  ran on**.
- `checkProtocolVersion` inlined in two places let **NaN through**: a naive
  `theirs >= min && theirs <= max` is false for NaN, so `!(too old) && !(too
  new)` reads as compatible.
- The script API's ancestor walk listed a node as its own ancestor on a
  `parentId` cycle.
- `script-api.test.ts` typechecked only because vitest strips types. **`npm
  test` passing is not evidence a test file typechecks.**
- The toolbar registry's first draft keyed widgets with a `display: contents`
  wrapper, which wins `.toolbar__zoom > :last-child` and matches even when the
  widget inside renders nothing.
- `spaceterm-cli capabilities` exited non-zero on an *expected* cold-boot
  absence — the same cry-wolf mistake as the pgrep probe, caught before it
  shipped.

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

- **`server/index.ts`** (2490, down from 3087). Five tenants have moved out
  (`agent-provisioning`, `script-api`, `resume-target`,
  `restart-recovery`, `startup-reconciliation`). What remains is `handleMessage` — a ~990-line switch over
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

### Card component unification — done

`App.tsx`'s four non-terminal card blocks now share one prop bundle
(`cardProps`), and the file lost 49 net lines. `tieredZIndex` moved into the
CardType registry as `zIndexTier`, so a new card type declares its stacking
rather than being remembered in an if-chain elsewhere.

Two things that emerged and are worth carrying forward:

- **`x` and `y` are a card's centre, not its top-left.** Every card subtracts
  half its own size. Nothing said so anywhere before `card-contract.test.tsx`.
- **`CardShell`'s root is byte-identical for every card**, including the canvas
  root marker. The shared half was already shared; the divergence was all
  inside.

`TerminalCard` stays separate — its shell genuinely differs — and its mount
effect now has lifecycle coverage
(`TerminalCard.lifecycle.test.tsx`, 15 tests): the focus gate, registration
under node id rather than session id, and the cleanup of the four module-level
Maps `App.tsx` uses as a keyboard side-channel. Those Maps had been flagged as
an escape hatch for three sessions with nothing checking they empty out.

What is still uncovered inside that effect is terminal *behaviour* — the
custom wheel handler, selection, the search addon, WebGL fallback. jsdom mounts
xterm fine (given the setup file's `matchMedia` and canvas stubs), so most of it
is reachable; it is a question of appetite rather than of infrastructure.

## Ideas for the next sessions

Not backlog items with agreed shapes — the things that would most improve the
software, roughly ordered by value per unit of risk. Struck-through entries were
done last session; kept so the reasoning is not lost.

### Reliability

1. ~~**The client socket is unversioned.**~~ Done. `client-hello` mirrors
   `script-hello`, and both now share one `checkProtocolVersion`.
2. ~~**No integration test spans the whole server.**~~ Largely done from two
   directions: `startup-recovery.test.ts` drives the recovery sequence against
   an in-memory daemon with real managers, and the E2E suite launches all three
   processes for real. What is still uncovered is the middle — a client
   connecting over the socket and driving a terminal through `handleMessage`.
   The E2E layer *could* cover that; keeping it there rather than building
   another in-process harness is probably the right call.
3. ~~**Startup reconciliation**~~ — done at both levels. The decision is
   `startup-reconciliation.ts` (18 tests); the sequence is
   `startup-recovery.ts`, driven end to end against an in-memory daemon (32
   tests) including the reattach-fails-fall-through path and the orphan sweep.
   The only piece left outside a test is the 30-second revival-protection
   window, which is a `setTimeout` in `index.ts`.
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
    already has (a metric, a toggle), and nine of thirteen toolbar widgets
    already satisfy the standalone contract.

## Things deliberately not done

- **`session-title-summarizer.ts` has no seam.** It is hard-disabled at
  `const ENABLED = Boolean(false)`. Add the seam when it is turned back on.
- **No UTF-8 sanitizer.** The ESC-eats-the-escape defect does not reproduce
  against current xterm.js — tested by driving `@xterm/headless` with the exact
  bytes rather than assumed. See the rewritten `Potential UTF Bug Fix.md`. The
  investigation found a real bug next door instead (Unicode 6.0 vs 11.0 width
  tables between the snapshot and visible terminals), which is fixed.
- **`--ignore-scripts` still skips `electron-rebuild`**, and should: it compiles
  native modules against Electron's headers and the repo has no native
  dependencies of its own. Electron's *binary* download is no longer skipped —
  see "The premise that was wrong".
- **Playwright is pinned to `playwright-core@1.56.0`** and must stay there. The
  Playwright browser CDN is firewalled in this container, so the only usable
  Chromium is the preinstalled one at `/opt/pw-browsers` (revision 1194, which
  is exactly 1.56.0). A routine `npm update` would silently break browser
  launching. The Electron E2E path does not depend on that Chromium — it uses
  Electron's own — but any future `@vitest/browser` work would.
- **Pixel rendering is still not asserted.** The E2E suite proves the app comes
  up and the DOM is right; it does not compare screenshots. Visual regression
  would need a stable rendering environment and a baseline story, and is a
  bigger commitment than it looks.
- **No test drives a terminal through a full agent session.** The E2E harness
  can type into an xterm and read output back, so this is reachable — it just
  needs an agent CLI present, which CI will not have.
