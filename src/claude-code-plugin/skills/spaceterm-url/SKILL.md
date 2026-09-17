---
name: spaceterm-url
description: Use this skill only when a user explicitly asks for a Spaceterm URL.
---

# Spaceterm URLs

A Spaceterm URL raises Spaceterm and flies the camera to one surface:

```
spaceterm-surface://<uuid>
```

The scheme is `spaceterm-surface://`. Plain `spaceterm://` is not registered and
does nothing.

`<uuid>` can be either of two ids, and both work:

- **Your agent session ID** (Claude, Codex, or Cursor). This is the one you most
  likely have, so use it.
- **The surface ID**, from the `SPACETERM_SURFACE_ID` environment variable.

The server treats the id as opaque. It tries it as a surface ID first, then as an
agent session ID. If the surface has been archived, the link restores it. If
nothing matches, Spaceterm still comes to the front and zooms out to the whole
canvas.

Give the user the bare URL, e.g. `spaceterm-surface://3f2a9c1e-8b4d-4e6f-9a2b-7c5d1e0f4a3b`.
Trailing or doubled slashes are tolerated.
