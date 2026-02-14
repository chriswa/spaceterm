# Tile Memory Limits Mitigation Strategies

## The Root Problem

The `tile_manager.cc WARNING: tile memory limits exceeded` error comes from Chromium's GPU compositor. It breaks web content into rectangular **tiles**, rasterizes them to GPU textures, and manages them with a priority-based memory budget. When you have many xterm.js instances, each with its own canvas/WebGL context, you're burning through that budget fast.

Key hard limits:
- **WebGL contexts**: Browsers cap at **16 on desktop**, 8 on mobile
- **Memory per terminal**: ~34MB for a 160x24 terminal with 5000-line scrollback
- **Each BrowserWindow**: 150-250MB overhead from Chromium's process model

## Strategy 1: Server-Side State + Client Snapshots (Mosh-Style)

This is exactly what **Mosh** does with its State Synchronization Protocol (SSP):
- Runs a **full terminal emulator server-side**, maintaining screen state
- Sends **diffs** (only changed cells) rather than full frames
- Can **skip intermediate frames** when bandwidth is tight — it sends idempotent diffs from state N to state M
- Uses UDP so it can regulate sync rate to avoid filling network buffers

The tooling exists to do this in our stack:
- **`@xterm/headless`** — official headless xterm.js that runs in Node.js, no DOM needed
- **`@xterm/addon-serialize`** — captures full terminal state (text, colors, attributes, cursor position, wrapping) as a string that can be fed back into a new xterm instance
- Serialization speed: ~5000 rows in 200ms, ~25MB/s throughput

> **Effort**: High. Requires adding `@xterm/headless` to the server, wiring PTY output through it, building a new protocol message type for snapshots/diffs, and adding bandwidth throttling logic. Touches server, protocol, and client.
>
> **Risk**: Medium. `@xterm/headless` and `@xterm/addon-serialize` are official xterm.js packages with real-world usage, so the core serialization is trustworthy. The risk is in the plumbing — getting the snapshot cadence, diff format, and focus-switching transitions to feel seamless. A full Mosh-style diff protocol adds significant complexity; starting with periodic full serialized snapshots would be a safer first step.
>
> **Confidence**: High that it would solve the problem. This is the architecture that Mosh has proven at scale. The question is how much latency the serialize/deserialize cycle adds when switching focus.

## Strategy 2: Destroy + Restore (VS Code's Approach)

VS Code uses xterm.js too and handles many terminals by:
1. **IntersectionObserver** (built into xterm.js since v3.1.0) automatically pauses rendering when a terminal element is completely hidden
2. But this only pauses — the WebGL context and buffers still exist

The more aggressive version: **fully dispose** unfocused xterm instances and serialize their state. When the user refocuses, deserialize and recreate. This trades CPU (serialize/deserialize) for GPU memory.

**Critical finding**: Neither `display: none`, `visibility: hidden`, nor `content-visibility: auto` actually free GPU tile memory. Only **removing from DOM** (`element.remove()`) truly frees it. So you'd need to actually dispose the xterm instance, not just hide it.

> **Effort**: Medium. The client already creates/disposes xterm instances on mount/unmount. The main work is adding serialize-before-dispose and write-serialized-on-remount logic in `TerminalCard`, plus managing the serialized state somewhere (either in React state or fetched from server). Pairs naturally with Strategy 1 if the server already holds headless state.
>
> **Risk**: Low-Medium. The serialize addon is marked "experimental" but is widely used. The main UX risk is a visible flash or delay when switching focus — recreating a terminal and replaying serialized state takes some time. Also need to handle edge cases: what if the terminal has an active selection, or is mid-scroll, or the process writes data while the instance is disposed?
>
> **Confidence**: High. This directly addresses the root cause (too many live xterm instances eating GPU tiles). Even without Strategy 1, you could serialize client-side before disposing.

## Strategy 3: Single Shared WebGL Context

There's an [open xterm.js issue #4379](https://github.com/xtermjs/xterm.js/issues/4379) proposing exactly this — one hidden WebGL context using `gl.scissor` and `gl.viewPort` to render all terminals. This would bypass the 16-context browser limit. Not implemented yet, but the concept is sound.

> **Effort**: Very High. This would require forking or deeply patching xterm.js's WebGL addon to decouple it from per-instance context creation. You'd be building a custom rendering layer on top of xterm's internals.
>
> **Risk**: High. No one has done this yet — the xterm.js issue is still open with no implementation. You'd be fighting against xterm's architecture. Maintenance burden would be significant as xterm.js evolves.
>
> **Confidence**: Medium. The concept is proven in other domains (game engines routinely share GL contexts), but applying it to xterm.js specifically is uncharted territory. Probably not worth pursuing unless Strategies 1/2/5 prove insufficient.

## Strategy 4: Canvas/DOM Renderer for Unfocused Terminals

The WebGL renderer is 900% faster but uses 5-10x more memory than Canvas2D. You could:
- Use WebGL for the **focused** terminal
- Use the **DOM renderer** (built into xterm.js core, zero GPU) or **canvas renderer** for unfocused but visible terminals
- Use **nothing** (serialized snapshots rendered as static HTML) for fully backgrounded terminals

> **Effort**: Medium. xterm.js lets you load renderer addons dynamically. The tricky part is swapping renderers on a live terminal — you'd likely need to dispose the old renderer addon, load the new one, and trigger a full re-render. Need to verify whether hot-swapping renderers is actually supported without recreating the terminal.
>
> **Risk**: Medium. The DOM renderer is built-in and reliable but slow. Canvas renderer is a separate addon. The risk is that swapping renderers causes visual glitches or brief blank frames. Also, even the DOM renderer still creates DOM elements that consume some tile memory — it's cheaper than WebGL but not free.
>
> **Confidence**: Medium. Reduces per-terminal GPU cost but doesn't eliminate it. Each unfocused terminal still has a live xterm instance consuming memory for buffers and DOM. This is a half-measure compared to Strategy 2 (full dispose) or Strategy 5 (static HTML).

## Strategy 5: Render Static Snapshots as HTML

Instead of running any xterm instance for unfocused terminals, render their last known state as static HTML/canvas:
- `@xterm/addon-serialize` has a **`serializeAsHTML()`** method that outputs styled HTML
- Libraries like `ansi_up` or `terminal-to-html` convert ANSI output to colored HTML
- This gives you a visual preview with **zero GPU cost** — just DOM text

> **Effort**: Low-Medium. If Strategy 1 is in place (server has headless instances), the server can call `serializeAsHTML()` and send the result. The client just sets `innerHTML` on a div. Even without Strategy 1, you could serialize client-side before disposing. The main effort is styling the HTML output to visually match a real xterm instance so the transition isn't jarring.
>
> **Risk**: Low. Static HTML is as lightweight as it gets — no canvas, no WebGL, no GPU tiles beyond normal text rendering. The risk is purely cosmetic: the snapshot may not look pixel-identical to a live terminal (font rendering differences, missing cursor blink, etc.).
>
> **Confidence**: High. This is the most direct path to "zero GPU cost for unfocused terminals." Combined with Strategy 2 (dispose real instance) this gives you the full picture: one real xterm for focused, HTML previews for visible-but-unfocused, nothing for offscreen.

## Strategy 6: Chromium Flags (Quick Wins) — IMPLEMENTED

These won't solve the fundamental problem but can buy headroom. Added to `src/client/main/index.ts` before `app.whenReady()`:

```javascript
app.commandLine.appendSwitch('force-gpu-mem-available-mb', '4096');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy'); // ~40% less tile redraw time
app.commandLine.appendSwitch('ignore-gpu-blocklist');
```

Also: `max-tiles-for-interest-area` can be bumped from 128MB default to 256/512MB.

**Caveat**: Chromium doesn't strictly enforce these limits — they help but aren't reliable.

## Strategy 7: CSS `content-visibility: auto` — IMPLEMENTED

Added `content-visibility: auto` and `contain-intrinsic-size` to `.terminal-card` in `src/client/renderer/src/styles/index.css`. For terminals that are in the DOM but scrolled out of view, this tells the browser to **skip creating tiles** for offscreen content entirely. This is the cheapest change with meaningful impact for scrollable layouts.

## Recommended Architecture

Combining the best of all approaches:

| Terminal State | Rendering Strategy |
|---|---|
| **Focused** | Full xterm.js with WebGL renderer, live PTY data |
| **Visible but unfocused** | Static HTML snapshot from `serializeAsHTML()`, updated periodically by server |
| **Not visible (different tab/scrolled away)** | Removed from DOM entirely. Server maintains state via `@xterm/headless`. Restored on demand |

The server would:
1. Run `@xterm/headless` + `@xterm/addon-serialize` for every session
2. Feed PTY output into headless instances to maintain state
3. Stream live PTY data only to the **focused** terminal
4. Periodically serialize unfocused terminals and send snapshots (HTML or cell-diff format)
5. Throttle snapshot updates based on bandwidth / change frequency (Mosh-style)

This means the client only ever runs **one** real xterm.js instance at a time, with everything else being lightweight HTML previews or nothing at all.

## Key References

- [xterm.js issue #4379: Support dozens of terminals on a single page](https://github.com/xtermjs/xterm.js/issues/4379)
- [xterm.js issue #880: Pause/resume rendering](https://github.com/xtermjs/xterm.js/issues/880)
- [@xterm/headless on npm](https://www.npmjs.com/package/@xterm/headless)
- [@xterm/addon-serialize on npm](https://www.npmjs.com/package/@xterm/addon-serialize)
- [Mosh: State Synchronization Protocol](https://mosh.org/mosh-paper-draft.pdf)
- [Eternal Terminal reconnection protocol](https://eternalterminal.dev/howitworks/)
- [Chromium GPU Accelerated Compositing](https://www.chromium.org/developers/design-documents/gpu-accelerated-compositing-in-chrome/)
- [Chromium Tile Prioritization](https://www.chromium.org/developers/design-documents/impl-side-painting/)
- [VS Code terminal renderer architecture](https://code.visualstudio.com/blogs/2017/10/03/terminal-renderer)
