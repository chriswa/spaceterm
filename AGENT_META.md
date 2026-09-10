# Agent meta

FEATURE: Turn on "Agent Meta" for any directory node or the root and Spaceterm
grows a live, self-maintaining branch showing that project's `CLAUDE.md` and
every `SKILL.md` under it — each card reads as its own header until you click it
open into an editor that writes back to disk.

This is a design note for what was built, not a plan. It exists because the
interesting decisions here are invisible in the diff: almost all of them are
about what these cards are *not* allowed to do.

## The shape

```
host (directory node, or the root)
└── Agent Meta          ← what the toolbar button toggles
    ├── CLAUDE.md       ← a meta-doc
    └── Skills · 4
        ├── recall      ← meta-docs
        └── session-id
```

| Host | Where it looks |
|---|---|
| Root node | `~/.claude` — `CLAUDE.md` and `skills/` directly inside |
| Project | `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/skills/*/SKILL.md` |
| Plugin (`.claude-plugin/plugin.json`) | `CLAUDE.md` and `skills/*/SKILL.md` — no `.claude` anywhere |
| Marketplace (`.claude-plugin/marketplace.json`) | follows the manifest into each local plugin, keys prefixed by plugin name |

That last row is not hypothetical: `~/chriswa-devkit` is a marketplace, and its
skills live one level down in `default-plugin/`. A scanner that only knew
`.claude/skills` and plugin roots reported the repo as having nothing.

Two more things the real files taught us, both caught by fixture tests against
this machine rather than by invented examples:

- **`name:` is optional in a `SKILL.md`.** Three of the six skills here omit it
  and let Claude Code take the name from the directory. A card that insisted on
  the header would show half of them untitled — hence `documentSummary(text,
  fallbackName)` rather than a `name | undefined`.
- **Directory nodes store their cwd `~`-abbreviated** (`abbreviateCwd`), so the
  common case under `$HOME` is `~/spaceterm`. Handing that to the scanner
  unexpanded means the feature never works for most real directory nodes.

## The one idea

**Generated cards live in `state.nodes` in memory and are filtered on the way to
disk.**

Living in `state.nodes` buys edges, camera fit, focus, z-order, colour
inheritance, hit-testing and the label layer for free, instead of a second node
source every one of those would have to learn about. Being filtered on write is
what keeps `state.json` safe.

`BaseNodeData.ephemeral` marks them. Two gates enforce it, not nine:

- **`StateManager.refuseEphemeral`** — consulted by every persisting mutation.
- **`serializeState`** — drops them from the node map on the way out.

The first draft of this design guarded three hand-picked call sites. Every leak
found afterwards had the same shape: a *generic* path over `state.nodes` that
nobody had thought of. Those are worth naming, because they are what the two
gates are actually for:

- **`archiveSubtree`** deep-copies the live subtree into persisted
  `descendants`. Archiving a host would have written every generated card down
  *and* resurrected stale copies of files as real nodes on restore.
- **`batchMoveNodes`** is the path a subtree drag takes — the single most
  ordinary gesture once a branch is open.
- **`bringToFront`** advances `nextZIndex`, which is persisted, so merely
  clicking a card moved a number on disk. Generated cards draw z from a separate
  in-memory counter.
- **The undo buffer** is persisted, so a drag that included generated cards put
  ids in `state.json` that nothing could ever resolve. Filtered in
  `handleDragStart`.
- **`hasLiveChildren`** decides whether archiving a card takes a branch with it.
  Counting an open branch would mean that merely *looking at* a directory's
  skills changed what archiving it does, and would put generated cards in the
  count the confirmation dialog reads out.

The write filter drops nodes **by key**, rebuilding one object, rather than
returning `undefined` per node from the replacer. Inside an *array* —
`archivedChildren` — `JSON.stringify` writes `null` for a dropped element, and a
hole there is read back as an entry and dereferenced on the next load.

A real node that would persist under a generated parent is impossible through
the API, so the filter **reports rather than repairs**: loud in production, fatal
under test. Rewriting a `parentId` on the way out would hide the bug and put a
value on disk that disagrees with memory.

## What persists

One top-level key. Presence is *not* the enabled flag — that was the first
version, and it meant closing a branch threw away every card position, which is
a thing you do repeatedly.

```ts
metaHosts: Record<NodeId, {
  open: boolean
  groupPos?: { x, y }
  cardPos?: Record<string, { x, y }>   // keyed by what the card shows
}>
```

`cardPos` is keyed by the skill's directory name, not by node id — ids are
regenerated every boot, keys are not — and is pruned to the current scan on
every rescan, so it cannot grow without bound and cannot re-apply one repo's
layout to another's same-named skill. An entry that remembers nothing is dropped
outright, so a host opened once and closed leaves the document as it found it.

Node ids are deterministic (`meta:<hostId>:doc:<key>`) for identity, not
persistence: deep-link focus, camera history and the renderer's expanded-card set
are all keyed by node id.

**State version 4.** An older build refuses it and starts empty, preserving the
file as `state.json.v4` (`startFresh`'s `v${found}` label). Rolling back means
renaming that back.

## Two traps worth remembering

**`FileContentManager.startWatching` creates a missing file and mkdirs its
parent.** Right for a file card — you point it at a path you intend to have —
and a grenade for a scan-driven one, which exists *because* the file does. A
skill deleted inside the rescan debounce window would have had its directory and
an empty `SKILL.md` written back into the repo, and the watcher would then have
seen a legitimate new skill: a phantom that sustains itself across a
disable/enable. Hence `createIfMissing: false`.

**The write-back path edits files inside the tree being watched**, so without
suppression every pause in typing would trigger a rescan. `noteSelfWrite` is the
same idea as `FileContentManager`'s per-entry echo suppression, one level up.

## `CardType` split

`CardType` used to mean "a card that persists" — `persistence-roundtrip`
asserted every member survived a write — which made "renders like any other card,
persists like none of them" a contradiction rather than a design.
`PERSISTED_CARD_TYPES` / `EPHEMERAL_CARD_TYPES` name the split, and a test
asserts they cover the registry, so a new card type must still be classified in
one direction or the other.

Note the flag and the type answer different questions. Whether a *node* is
skipped on write is decided by its own `ephemeral` field — that is what a generic
path over `state.nodes` can check without knowing card types exist.

## Known gaps

- Skill cards cannot be archived, reparented, coloured, or given children. All
  deliberate; the consequence is that "spawn a terminal under this skill" is not
  available.
- Two hosts can point at one skills root (the root node and a directory node
  whose cwd is `~`). You get two sets of cards over the same files and
  last-write-wins between them. Not guarded.
- Availability is a memoised `stat` sweep on a 60 s interval, so a `.claude/`
  created just now lights the button up within a minute rather than instantly.
- Not exercised end-to-end in the real app yet. Server logic and both card
  components have unit and jsdom coverage; nobody has watched it run.
