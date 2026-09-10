# Skill nodes

FEATURE: Turn on "Skills" for any directory node (or the root node) and Spaceterm
grows a live, self-maintaining branch of the canvas showing every `SKILL.md` under
that project's `.claude/skills` — each card reads as its frontmatter until you
click it open into a full markdown editor that writes back to disk.

CAVEATS:

- **`state.json` version bumps to 3.** An older build will refuse a v3 file and
  start empty, preserving it as **`state.json.v3`** (that is `startFresh`'s
  `v${found}` label, `persistence.ts:201` — *not* `.v2`, which is what the
  forward migration writes). Rolling back means renaming that file back.
- **`CardType` changes meaning** from "a card that persists" to "a card that
  renders". See §2 — this is the load-bearing decision in the whole plan.
- **Skill cards cannot be archived, reparented, coloured, or given children.**
  Deliberate (§3). The obvious "spawn a terminal under this skill" gesture is not
  available in v1.
- **Two hosts can point at one skills root** (the root node and a directory node
  whose cwd is `~`). You get two sets of cards over the same files, and two
  editors with last-write-wins between them. Not guarded.
- **The availability probe is a stat on a 60 s sweep,** not a subscription. A
  `.claude/skills` created just now lights the button up within a minute.

---

## 1. What the user sees

1. Focus a **directory node** or the **root node**. The action bar shows a new
   **Skills** button (book icon): greyed with *"No .claude/skills here"*, enabled
   with *"Show skills"*, highlighted with *"Hide skills"* once on.
2. Clicking it spawns a **Skills group node** as a child of the host: a
   title-shaped card reading `Skills · 4`. Draggable, **not** editable, **not**
   closeable, **not** colourable — it inherits the host's colour. Clicking its
   label rescans.
3. Below it, one **skill card** per skill, in a column.
   - **Collapsed (default):** the skill's `name` in title face and `description`
     in body face. This *is* the frontmatter, rendered.
   - **Expanded (click):** the whole `SKILL.md` in a CodeMirror markdown editor,
     editable, debounced back to the file. External edits stream in live.
4. Add, delete or rename a skill on disk and the cards follow within ~200 ms.
   Cards that stayed keep their positions.
5. Clicking Skills again tears the branch down. Nothing archived, nothing in the
   undo buffer — it was never yours to lose.

| Host | Skills root |
|---|---|
| Root node | `~/.claude/skills` |
| Directory node, cwd `D` | `D/.claude/skills`, or `D/skills` when `D/.claude-plugin/plugin.json` exists |

The second rule is what makes `~/chriswa-devkit/default-plugin` work: a plugin
root keeps skills at `skills/`. Commands are out of scope — a command is a skill
with one extra frontmatter line.

**`cwd` is stored `~`-abbreviated.** `createDirectory` runs `abbreviateCwd`
(`state-manager.ts:1192`), so the common case holds `~/spaceterm`. Every path
leaving `SkillsManager` toward the filesystem goes through `resolveFilePath`
(`path-utils.ts:11`) first. Without this the feature never works at all.
(`updateDirectoryCwd` at `:1216` does *not* abbreviate — the field is
inconsistent between create and edit, so normalise on read, never on write.)

---

## 2. `CardType` splits in two

Today `CardType` means "a card that persists", and
`persistence-roundtrip.test.ts:176` enforces exactly that:

```ts
expect([...present].sort()).toEqual([...CARD_TYPES].sort())
```

The feature needs card types that render but never persist. So `card-types.ts`
gains the distinction explicitly, rather than the plan quietly breaking that
assertion:

```ts
export const EPHEMERAL_CARD_TYPES = ['skill-group', 'skill'] as const
export type EphemeralCardType = (typeof EPHEMERAL_CARD_TYPES)[number]
export function isEphemeralCardType(t: CardType): t is EphemeralCardType
export const PERSISTED_CARD_TYPES = CARD_TYPES.filter(t => !isEphemeralCardType(t))
```

This one declaration is the source both halves derive from: `serializeState`
filters by it, and the round-trip generator generates from
`PERSISTED_CARD_TYPES` while a new sibling test asserts the ephemeral ones are
dropped. Adding a card type still cannot be done silently.

**Adding two `CardType`s is a compile error in four places** — all wanted, none
optional:
`persistence-roundtrip.test.ts:60` (`makeNode`'s switch),
`card-types.test.ts:126` (`Record<CardType, …>` samples),
`App.tsx:1841` (`createChildNode`'s switch — `let nodeId: NodeId` becomes
used-before-assigned), and `measureCard`'s `assertNever`.

**And one place that is *not* a compile error and must be fixed first**:
`nodeStore.ts:80`

```ts
} else if (node.type === 'title') { titles.push(node) }
else { markdowns.push(node) }        // ← catch-all
```

An unrecognised type lands in `markdowns` and `App.tsx:2542` renders it as a
`MarkdownCard` with `width`/`height`/`content` all `undefined`, then
`App.tsx:233` feeds a `NaN × NaN` rect to the WebGL edge mask. Silent. This
becomes an exhaustive switch with `assertNever` in step 2, before any producer
exists.

---

## 3. Safety: two chokepoints, not nine hand-picked guards

**Generated nodes live in `state.nodes` in memory and are filtered on the way to
disk.** Living in `state.nodes` buys edges, camera fit, focus, z-order, colour
inheritance, hit-testing, RTS select and the label layer for free. Being
filtered on write is what keeps `state.json` safe.

`BaseNodeData` gains `ephemeral?: true`, set only by `SkillsManager`.

The first draft of this plan guarded three call sites by hand. That was wrong:
every leak found in review was a *generic* path over `state.nodes` that a
hand-picked list had missed. So:

### Chokepoint A — `StateManager.assertMutable(node)`

One private predicate, consulted by **every** mutator that calls
`schedulePersist()`. Ephemeral nodes are refused (log + no-op), which closes all
of these at once:

- `archiveNode` (`:803`) — refuse. Also: its reparent-children loop must skip
  ephemeral children, so archiving a *host* tears skills down rather than
  orphaning them onto the grandparent.
- `moveNode` / `batchMoveNodes` (`:687`) — route to `setSkillsHostPos` instead of
  persisting. **`batchMoveNodes` is the important one**: `handleDragEnd`
  (`App.tsx:628-645`) sends the dragged node *and its whole subtree*, so dragging
  a Skills-enabled directory — the most ordinary gesture in the feature — is the
  leak.
- `bringToFront` (`:733`) — `node.zIndex = this.state.nextZIndex++`, and
  **`nextZIndex` is persisted** (`state.ts:204`). Clicking a skill card would
  permanently advance it. Ephemeral nodes draw z from a separate in-memory
  counter; `createSkill`/`createSkillGroup` do the same, which is also what makes
  the "enable → rescan → disable is byte-identical" test achievable.
- `renameNode` (`:705`), `setNodeColor` (`:713`) — refuse. Hence "not
  colourable" in §1: there is nowhere in `skillsHosts` to keep a colour, and
  silently discarding the user's choice on restart is worse than not offering it.
- `setAlert`, `setAlertsReadTimestamp`, `recordInteraction`, `reparentNode`,
  `swapParentChild` — refuse.

### Chokepoint B — `tree-utils` becomes ephemeral-aware

`hasLiveChildren` (`tree-utils.ts:48`) is a bare `parentId` scan. As written,
**turning Skills on gives the host a live child, so its X button greys out and
`Cmd+W` shakes** — a real regression, and it makes the `node-archive →
onHostRemoved` hook unreachable from the UI. `hasLiveChildren` and the descendant
walk must skip ephemeral nodes. That single change also makes the archive guard
above meaningful.

Client-side, `handleDragStart` (`App.tsx:604-609`) filters ephemeral ids out of
`preDragPositionsRef`, so no `UndoMoveEntry` can ever carry one. An undo entry
naming a node that no longer exists is the one way a reap reaches disk.

### The write filter

`serializeState` (`persistence.ts:95`) is a streaming `JSON.stringify` replacer,
kept that way deliberately — a deep clone of every node on each debounced write
would be the most expensive thing the server does at idle.

Filter **by key**, not by returning `undefined` per node:

```ts
if (key === 'nodes') return filterEphemeral(value)   // one shallow rebuild
```

Returning `undefined` for a node object anywhere else is a trap: inside an
**array** — `archivedChildren` — `JSON.stringify` writes `null`, not nothing.
`archiveNode` deep-copies via `JSON.parse(JSON.stringify(node))` (`:829`) and
`isDisposable` has `default: return false` (`node-utils.ts:31`), so a leak there
would put `"archivedChildren": [null]` on disk, which `archiveEntryAt` (`:875`)
and `search.ts:80` both dereference on next load.

**The first draft's "re-point orphaned parentIds" idea is cut.** It cannot be
done inside a streaming replacer without the pre-pass the replacer exists to
avoid, and it would write a `parentId` to disk that disagrees with memory. What
replaces it: if the filter ever finds a surviving node whose parent was dropped,
it logs loudly — and **throws in tests**. The tripwire, not the mechanism.

### Tests that hold the line — the deliverable, not an extra

- Round-trip: ephemeral nodes are absent from the document; every surviving
  `parentId` resolves; an ephemeral node planted in `archivedChildren` produces
  no `null`.
- `state-manager.test.ts`: archive / reparent / swap / rename / colour /
  bringToFront against an ephemeral node each leave persisted state untouched —
  `nextZIndex` included.
- `skills-manager.test.ts`: enable → rescan (one skill added, one removed) →
  disable leaves the persistable state byte-identical to before enable.

---

## 4. Persisted state — one new top-level key

```ts
// ServerState
skillsHosts: Record<NodeId, SkillsHostEntry>   // ROOT_NODE_ID is already a NodeId

interface SkillsHostEntry {
  groupPos?: { x: number; y: number }
  cardPos?: Record<string, { x: number; y: number }>   // keyed by skill dir name
}
```

Presence of the key **is** the enabled flag. Nothing else persists: not ids, not
content, not sizes, not which cards are expanded.

Chosen over a field on `DirectoryNodeData` because the root node is not in
`state.nodes` and would have needed a second home anyway, and because it keeps
`NodeData` — which every archive snapshot deep-copies — free of it.

`cardPos` is **pruned to the current scan on every successful rescan**.
Otherwise it grows without bound, and pointing a directory node at a different
repo lets a same-named skill (`code-review` and `finish` each exist under more
than one root on this machine) inherit the wrong position.

**Migration 2 → 3**: `if (!isRecord(doc.skillsHosts)) doc.skillsHosts = {}`.
`CURRENT_STATE_VERSION = 3`. Startup prunes entries whose host is gone. Note the
e2e fixture (`e2e/app-launch.test.ts:262`) seeds `version: 2` and will now
migrate + `archive('v2')` on every launch — bump it.

Node ids are **deterministic**: `skills:<hostId>` and `skill:<hostId>:<skillKey>`.
Not for persistence — for identity, so deep-link focus, `camera-history` and
`focus-storage`'s localStorage round-trip keep working across a server restart.

---

## 5. Two new card types

Both registered in `CARD_TYPES` / `CARD_TYPE_SPECS` and in
`EPHEMERAL_CARD_TYPES`; both absent from `AddNodeBody`'s hand-written `items`
array, so neither can be created by hand.

```ts
interface SkillGroupNodeData extends BaseNodeData {
  type: 'skill-group'; ephemeral: true
  hostId: NodeId; skillsRoot: string; skillCount: number
}
interface SkillNodeData extends BaseNodeData {
  type: 'skill'; ephemeral: true
  hostId: NodeId; skillKey: string; skillPath: string
  width: number; height: number     // client-measured, like markdown
}
```

`skill-group`: `contentSized`, `zIndexTier: TIER.title`, `focusMaxZoom:
LABEL_FOCUS_MAX_ZOOM`, title's measure formula. `skill`: `contentSized`,
`TIER.base`, `focusMaxZoom: null`, `measureCard` returns `{ width, height }`.
Reusing existing tiers keeps `card-types.test.ts`'s 1M-gap assertion green.

Both stamp `lastInteractedAt: Date.now()` at creation, as `createDirectory` and
`createTitle` already do — without it `dim-stale` reads `undefined` as the oldest
band and renders every skill card permanently dimmed.

Content is **not** on the node. It arrives through the existing `file-content`
broadcast into the store's `fileContents` map — the same substitution file-backed
markdown already makes. Expansion is **client-local** (a `Set<NodeId>` in the
store): per-viewer, cheap, and deterministic ids make it survive a reload.

---

## 6. Server pieces

### `src/shared/frontmatter.ts` (new, pure)

`parseFrontmatter(text) → { name?, description?, body }`. Leading `---` fence,
`key: value` scalars, folded continuations, closing fence. No YAML dependency.
Parsed **on the client**, from content it already has, so no wire field carries
it and the card re-renders as you edit the frontmatter. In `src/shared` so
`renderer-purity.test.ts` stays satisfied.

### `src/server/skills-scan.ts` (new, pure)

`resolveSkillsRoot(absHostDir, io)` and `scanSkills(absRoot, io)` over an
injected `SkillsScanIO`. Takes **absolute** paths only — expansion happens at the
`SkillsManager` boundary (§1).

### `src/server/skills-availability.ts` (new)

The memoized probe behind the button: `Map<NodeId, { root, checkedAt }>`, 60 s
TTL, `invalidate(hostId)` on cwd change, riding the sweep the git poller already
runs. Broadcasts only on change:

```ts
{ type: 'skills-availability', nodeId: NodeId, available: boolean }
```

A dedicated broadcast, **not** `node-updated`'s `'root'` special case
(`nodeStore.ts:259`) — that case exists to handle `archivedChildren` and is a
wart, not an extension point.

### `src/server/skills-manager.ts` (new)

Deps-injected per the project's testing rule: `{ scanIO, watchDir,
scheduleTimeout }`. Methods `enable` / `disable` / `rescan` / `onHostChanged` /
`onHostRemoved` / `restoreFromState` / `dispose`.

`rescan` diffs by `skillKey`: added keys get a node, removed keys get their node
and watch torn down, surviving keys are left completely alone. New cards take
`cardPos[key]` if present, else the next slot in a column below the group — not
`node-placement`, which would scatter a set that reads better as a list.

Directory watch: `fs.watch(root, { recursive: true })`, falling back to
non-recursive, debounced 200 ms. **It must suppress its own writes** — the
write-back path (below) writes into the tree being watched, so every editing
pause would otherwise trigger a rescan. Mirror `WatchedEntry.lastWrittenContent`'s
existing echo suppression.

### `FileContentManager` needs one new parameter

It is otherwise reusable as-is, but `startWatching` **creates the file when it is
missing** (`:106-116`), and `REAL_FILE_CONTENT_IO.writeFile` (`:44`) `mkdirSync`s
the parent first. In a scan-driven flow that is a live grenade: a skill deleted
inside the 200 ms debounce window gets its **directory and an empty `SKILL.md`
recreated in the user's repo** — and the dir watcher then sees a legitimate new
skill, so the phantom card is self-sustaining and survives disable/enable.

Add `createIfMissing = true` to `startWatching`; skills pass `false` and treat a
missing file as "reap this card".

### `index.ts` wiring

New client messages: `skills-toggle { nodeId }` → ack `{ enabled }`,
`skills-rescan { nodeId }`, `skill-resize { nodeId, width, height }`,
`skill-content { nodeId, content }` (→ `FileContentManager.writeContent` only,
never `node.content`). Hooks: `directory-cwd` → `onHostChanged`; `node-archive` →
`onHostRemoved`; startup → `restoreFromState()` beside the file-backed-markdown
revival already there.

---

## 7. Client pieces

- **`nodeStore`**: exhaustive `recomputeDerived` (§2) plus `skillGroups` /
  `skills` arrays, a `skillsAvailability` map, and `expandedSkills: Set`.
- **`markdown-extensions.ts`** (new): `cmTheme`, `markdownDecorations`,
  `autolinkPlugin`, `linkClickHandler` lifted verbatim out of `MarkdownCard.tsx`
  and imported back. Pure extraction — the two-pass measurement, drag and
  draft-dimension machinery stays put, being the fiddly part and not worth
  sharing.
- **`SkillCard.tsx`** (new): collapsed frontmatter face, or expanded CodeMirror.
  Sizing deliberately simpler than markdown's: fixed width
  (`MARKDOWN_DEFAULT_MAX_WIDTH`), height from `scrollHeight` capped with internal
  scroll. Reports via `skill-resize`; edits debounce 300 ms into `skill-content`.
- **`SkillGroupCard.tsx`** (new): `TitleCard` with editing removed and a rescan
  click handler. Small enough to write outright rather than abstract over.
- **`App.tsx`**: two render blocks over the existing `cardProps` bundle — but
  that bundle hard-wires `onClose: handleRemoveNode` and `onAddNode:
  handleAddNode` (`:2442`, `:2445`), so both must be **overridden to `undefined`
  after the spread**, along with `showClose={false}` and
  `showColorPicker={false}`.
- **`NodeActionBar`**: one optional prop
  `skills?: { available, expanded, onToggle }`. `FloatingToolbar` spreads
  `nodeActionRegistry`'s props (`:48,71`), so the quick-action toolbar is free.
- **`RootNode.tsx`**: passes the prop through; it already goes via `CardShell`,
  so `nodeActionRegistry` covers `'root'`.
- **Text fallbacks**: `search.ts:52-59` `typeLabel` falls through to
  `data.type` (Cmd+K would list bare `"skill"` entries with no name and no
  searchable text, since content lives in `fileContents`); `node-title.ts:32`
  falls through to `data.id.slice(0,8)` (an undo toast reading `"skill:ro"`).
  Both need explicit cases. `node-label.ts:44` returns `null` for unknown types —
  right by luck; make it a stated case.
- **CSS** in `styles/index.css` following `.title-card` / `.markdown-card`, and
  the three new `NodeApi` methods in `fake-bridge.ts` so a stale fake is a
  compile error.

**Verified unaffected:** `snapshot-diff` and `crab-nav` are terminal-only;
`camera-history` stores ids opaquely and tolerates dead ones; `node-placement`
treats all nodes as obstacles, which is what we want; `cwd-alerts` scans only
terminals.

---

## 8. Order of work

Each step ends green on `npm run typecheck && npm run lint && npm test`.

1. `frontmatter.ts` + `skills-scan.ts` + tests. Pure, unwired.
2. **The safety net, before anything can produce an ephemeral node.**
   `ephemeral` on `BaseNodeData`; `EPHEMERAL_CARD_TYPES`; the `serializeState`
   key-filter; `assertMutable` across `StateManager`; ephemeral-aware
   `tree-utils`; exhaustive `recomputeDerived`; the drag/undo filter; all of §3's
   tests.
3. `skillsHosts` + migration to v3 + e2e fixture bump.
4. The two card types (`card-types.ts`, `state.ts`, `node-size.ts`,
   `measureCard`) plus the four compile-error sites from §2.
5. `skills-manager.ts` + tests against a fake fs and a real `StateManager`,
   including the byte-identical assertion.
6. Wire: protocol, `api.ts`, preload, `fake-bridge`, `index.ts`,
   `skills-availability`, `createIfMissing`.
7. `markdown-extensions.ts` extraction (renderer tests stay green), then
   `SkillCard` / `SkillGroupCard` + renderer tests + `card-contract.test.tsx`
   rows.
8. `NodeActionBar` button, `App.tsx` / `RootNode` wiring, text fallbacks, CSS.
9. `npm run flag-restart` — steps 2, 3, 5, 6 are server-side.

Steps 1–5 touch no renderer code and are individually revertable. **Step 2 must
not be reordered or split** — it is the only step whose absence is silent.
