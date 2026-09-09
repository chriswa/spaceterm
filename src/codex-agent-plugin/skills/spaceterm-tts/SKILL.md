---
name: spaceterm-tts
description: Use when the user asks for text-to-speech, to speak something aloud, or to read text out loud. Spaceterm provides a TTS tool over MCP that is not in Codex's initial tool set.
---

# Spaceterm text-to-speech

Spaceterm's MCP server (`spaceterm`) provides a `TTS` tool that speaks text through
the Spaceterm client's text-to-speech engine. Codex lazy-loads MCP tools, so `TTS`
is not in the initial tool set: use tool search to load the `spaceterm` server's
tools, then call `TTS` with the text to speak (2000 characters max).

Only reach for it when the user explicitly asks for speech.

The tool needs `SPACETERM_SURFACE_ID` in the environment. Without it this terminal
is not a Spaceterm surface and the call fails saying so.
