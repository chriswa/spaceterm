# Themeable mods

Can a mod add a themeable facet, and can themes have an opinion about it?

Yes, for the visual layer, and there is a working example in the repo. This
document is what the exploration found — including the three things that do
*not* work yet and would block a real extraction.

The worked example is the summary-chat speech bubble: the indicator under a
surface's toolbar icon that shows whether that surface is idle, thinking, or
speaking. It is the right test case because a theme plausibly wants to change
it (the grid theme has no use for a cyan-and-amber speech bubble) and because
the summarization system is destined to become a mod.

## What was built

`src/client/renderer/src/lib/theme/registry.ts` — a runtime facet registry, and
`src/client/renderer/src/mods/summary-chat/bubble-facet.tsx` — a facet
registered the way a mod would register one. `CrabGroup` now renders whatever
that facet resolves to instead of a hard-coded `<svg>`.

Selecting the grid theme swaps the speech bubble for a monochrome mark. No file
in `lib/theme` mentions the summary-chat mod, and no theme definition imports
from it.

## The design

### Two kinds of facet, on purpose

Core facets (`background`, `rootNode`, `nodeTint`, …) keep everything that
makes them pleasant: a closed `ThemeFacets` interface, `useFacet('rootNode')`
returning the right type, a compile error for a facet added to the type but not
to `DEFAULT_FACETS`, and a test asserting the runtime id list matches the type.

None of that can survive a mod. A mod is compiled separately — eventually
loaded separately — so it cannot widen an interface in this repo, and this repo
cannot name a type the mod owns. Rather than weaken the core to match, mod
facets are a second kind:

| | Core facet | Mod facet |
|---|---|---|
| Id | `background` | `summary-chat:bubble` |
| Declared in | `ThemeFacets` interface | `registerFacet()` at import time |
| Default from | `DEFAULT_FACETS` | the mod's own registration |
| Base knows the type | yes | no — stores it as `unknown` |
| Consumer typing | `useFacet(id)` | the mod's exported accessor |

The base never looks inside a mod facet's value. It stores it, resolves it, and
hands it back. Type safety for the mod's *consumers* comes from the mod
exporting a typed accessor:

```ts
export function useSummaryBubble(): SummaryBubbleFacet {
  return useModFacet<SummaryBubbleFacet>(SUMMARY_BUBBLE_FACET) ?? SUMMARY_BUBBLES.speech
}
```

This is the same line `ToolbarWidget` drew between standalone and host widgets:
a distinction the type system enforces, rather than a convention.

### Namespacing

`<modId>:<facetName>`. The colon is reserved — `registerFacet` rejects a core
id containing one and a mod id containing two, so `summary-chat:bubble` and
`weather:bubble` coexist and neither can squat on `background`.

### Resolution order, and which way the dependency points

1. The active theme's own `modFacets[id]`, if it has one.
2. The facet owner's `byTheme[activeThemeId]`.
3. The facet's `defaultValue`.

Step 2 is the important one, and it took a wrong turn to find. The obvious
design is for a theme to say "and here is my speech bubble" — but a base theme
**cannot** import from a mod. The mod may not be installed, and the base must
not depend on it.

So the arrow is inverted: the *mod* ships variants per theme. `summary-chat`
declares "if the grid theme is active, use the technical mark". The mod already
depends on the base, so naming a base theme id costs nothing, and a theme the
mod has never heard of just gets the default. A theme needs no knowledge of any
mod to be well-dressed by one.

Step 1 still exists so that a mod's *own* bundled theme, or a user's theme that
knowingly targets an installed mod, can override outright.

### Absence is not an error

A theme naming a facet no mod has registered resolves to `undefined` and the
override sits inert. Uninstalling a mod does not break the themes that dressed
it, and registration order does not matter — a theme is parsed long before a
mod's module runs. There is a test for exactly this.

## What does not work yet

These are the three things a real extraction would hit. None is fatal; all
three need a decision before the summarization system moves out.

### 1. CSS is still the base's

The bubble's *shape* is now themeable; its colours are not. Both variants still
resolve `.toolbar__summary-bubble--talking` out of the base stylesheet, so the
mod cannot ship its own styles and a theme cannot restyle it without editing
base CSS.

Two candidate fixes, and I would want your call:

- **Semantic tokens.** Extend the `cardChrome` idea into a general token facet:
  a theme publishes `--accent-active`, `--accent-pending`, `--surface-raised`
  and so on, and mods style themselves from those without either side knowing
  the other. This handles "maybe the colours they want are different" for
  *every* mod at once, and is the smaller change.
- **Mod-supplied stylesheets.** A mod ships CSS scoped to its namespace. More
  power, but it needs a scoping mechanism the app does not have, and it lets a
  mod's styles collide with the base's.

I lean strongly toward tokens, with mod-supplied CSS only if a mod needs
structure the tokens cannot express.

### ~~2. Nothing lets a mod contribute a *theme*~~ — built

`registerTheme` in `theme-registry.ts`. Mod themes are namespaced
(`my-mod:midnight`), appear in the picker beside the built-ins, and may arrive
after startup — the picker subscribes, and a persisted id for a theme that has
not registered yet falls back to the default and starts working the moment it
does.

The case that motivated it works with no coupling at all: a theme from mod A
can restyle a facet owned by mod B through `modFacets`, sharing nothing but the
string key. Neither imports the other, neither has to be installed, and load
order does not matter. `theme-registry.test.ts` pins all four of those.

`resolveTheme` was also made *total* while doing this — it previously ended in
a non-null assertion that would have crashed the renderer if the registry were
ever empty, which stopped being hypothetical once registration became open.

### 3. The rest of the summarization system is not extractable yet

The visual layer was the easy half. What is still wired into the base:

- `summaryChatStore` and `speakingStore` — the mod would own these.
- IPC: `summary-chat:start`, `summary-chat-status`, `speaking-changed` in the
  preload bridge and `SystemApi`'s neighbours in `shared/api.ts`. There is no
  way today for a mod to add a bridge channel; every channel is spelled out in
  the `Api` interface the preload implements. **This is the real blocker**, and
  it is Tier 1 in MODDING.md (the scripts socket), not a theming problem.
- `TerminalCard`'s speaking overlay and `.terminal-card__sonar*` CSS — same
  situation as the bubble, and the same fix would work.
- Server-side `summary-chat.ts` — out of scope for a renderer mod entirely.

So: **theming is ready for mods; the transport is not.**

That conclusion has since been revised, and the revision is in MODDING.md under
*Tier 3 — feature mods that span processes*. "A mod cannot own an IPC channel"
is true and beside the point: a mod does not need its own channel, it needs an
**envelope** — one `{ type: 'mod', modId, event, payload }` variant added once
to each union, routed by `modId`, never inspected. That is the same trick this
document describes for facets, applied to the wire, and it costs the base a
fixed amount rather than one channel per mod.

## Adding a themeable facet from a mod

```tsx
export const MY_FACET = 'my-mod:indicator' as const
export interface MyFacet { readonly id: string; readonly Component: ComponentType<Props> }

registerFacet<MyFacet>({
  id: MY_FACET,
  defaultValue: { id: 'default', Component: DefaultIndicator },
  byTheme: { grid: { id: 'flat', Component: FlatIndicator } },
})

export const useMyFacet = () => useModFacet<MyFacet>(MY_FACET) ?? FALLBACK
```

That is the whole contract. Nothing is registered with the base's build, and no
file in `lib/theme` changes.
