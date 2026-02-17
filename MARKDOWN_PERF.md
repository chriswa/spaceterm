# Markdown Card Performance: Snapshot Rendering

## Problem Statement

Spaceterm renders unfocused terminal sessions as canvas snapshots to avoid the overhead of many live xterm.js instances. The question: should we do the same for markdown cards (CodeMirror)?

## Current Terminal Snapshot Architecture

The terminal snapshot system exists because **xterm.js is unusually expensive** — WebGL renderer, per-cell DOM updates, mutation observers, resize observers.

How it works:
1. **Server** maintains headless xterm instances, serializes to `AttrSpan[][]` (rows of styled text runs with fg/bg colors, bold/italic/underline) at 10Hz
2. **Client** paints `AttrSpan[][]` to a `<canvas>` element — monospaced fixed-width grid, simple math
3. **Mode switching**: focused terminals show live xterm DOM; unfocused show the canvas snapshot
4. Server only sends snapshots to clients that have opted into snapshot mode for a given session

Key files:
- `src/server/snapshot-manager.ts` — server-side headless xterm + serialization
- `src/client/renderer/src/components/TerminalCard.tsx` — `paintCanvas()` function (~line 526), mode switching logic
- `src/shared/protocol.ts` — `SnapshotMessage`, `AttrSpan`, `SetTerminalModeMessage` types

## Why Markdown Is Different

Markdown cards use CodeMirror, which is **much lighter than xterm.js** when idle:
- Syntax tree is cached, not re-parsed
- ViewPlugins (`markdownDecorations`, `autolinkPlugin`) only rebuild on doc/viewport changes
- Event listeners are passive when not focused
- No WebGL, no per-cell DOM manipulation

The browser already optimizes static DOM:
- Composited layers (elements with `transform`) are cached as GPU textures
- Paint invalidation only repaints regions that actually change
- An idle CodeMirror editor costs zero repaint work — the rendered pixels are effectively already a "snapshot" at the compositor level

The real costs of many idle CodeMirror instances are:
1. **DOM node count** — affects layout/reflow calculations when other things change
2. **Memory** — each instance holds EditorState, syntax trees, DecorationSets
3. **JS objects** — event listeners, plugin instances (minor GC pressure)

## Why Canvas-from-AST Won't Work Well

A terminal is a fixed-width character grid — trivial to paint to canvas. Markdown is not:
- Variable font sizes (headings: 1.6em, 1.3em, 1.1em)
- Block-level features: code block backgrounds, blockquote left-borders, horizontal rules
- Inline styling: `border-radius` on inline code, underlined links
- Line wrapping depends on card width and `ctx.measureText()` won't match browser layout exactly
- Sub-pixel text positioning differences between canvas and DOM

You'd spend significant effort and never fully match the browser rendering.

## Recommended Approaches (When Needed)

### Option A: Static DOM Clone (recommended first step)

Destroy the CodeMirror instance when unfocused, keep its rendered DOM as a static clone.

```
// On unfocus:
const clone = editorElement.cloneNode(true)
clone.style.pointerEvents = 'none'
editorView.destroy()
// Show clone in place of editor

// On focus:
// Remove clone, re-create CodeMirror from stored `content` string
```

- **Pixel-perfect** by definition (it IS the browser rendering)
- **No dependencies**
- Eliminates JS/memory overhead of idle CodeMirror instances
- DOM node count stays the same (static nodes are cheaper than live CodeMirror nodes due to no observers/listeners)
- Transparent background works naturally
- Only need to re-clone if content changed while unfocused (track `isDirty`)

### Option B: html2canvas Capture

Capture the CodeMirror DOM to a `<canvas>` before destroying the instance.

```
import html2canvas from 'html2canvas'
const canvas = await html2canvas(editorElement, { backgroundColor: null }) // null = transparent
```

- Lighter DOM (single `<canvas>` element vs. full DOM tree)
- Adds `html2canvas` dependency (~40KB gzipped)
- Loses subpixel text rendering quality
- Good if DOM node count becomes the bottleneck

### Option C: CSS `content-visibility: auto`

A CSS-only optimization for off-screen cards:

```css
.markdown-card { content-visibility: auto; contain-intrinsic-size: auto 300px; }
```

- Browser skips rendering entirely for off-screen elements
- Zero code changes to the component
- Only helps with off-screen cards, not visible-but-unfocused ones
- May interact poorly with absolute positioning + transforms on the canvas

## Decision

**Wait until performance is actually a problem.** The browser's existing rendering cache handles idle CodeMirror well.

**When the time comes, use html2canvas (Option B).** The chosen approach:

1. **Capture timing**: Only on focus-lost, and only if dirty
2. **Dirty tracking**: Track an `isDirty` flag that gets set when:
   - Content text changes (edits)
   - Card width/maxWidth changes (affects word wrapping and line breaks)
   - Any other layout-affecting property changes
3. **On blur (if dirty)**: Call `html2canvas(editorElement, { backgroundColor: null })` to capture with transparent background, then destroy the CodeMirror instance and show the canvas
4. **On focus**: Re-create CodeMirror from stored `content` string, clear the canvas
5. **If not dirty on blur**: Keep the existing cached canvas, just destroy CodeMirror

This avoids unnecessary re-captures and keeps the snapshot perfectly in sync with the last edited state.
