# Text-to-Speech Setup

Spaceterm speaks through **Voice Operator**, a local speech service that runs as
a separate app. Everything that talks — the speak-the-selection chord, the MCP
`TTS` tool an agent can call, the `spaceterm-speak` CLI, and Summary Chat — goes
through it. Nothing is synthesized inside Spaceterm itself.

## Requirements

Voice Operator must be running. It publishes the port it is listening on to:

```
~/Library/Application Support/VoiceOperator/speech-service.json
```

Spaceterm reads that file on every request, so starting or restarting Voice
Operator needs no Spaceterm restart. If the file is absent, speech requests are
declined with "Voice Operator is not answering" and nothing is spoken — the rest
of the app is unaffected.

Voice selection, voice quality, and the mute control all live in Voice Operator.
A press made while Voice Operator has speech muted reports that, rather than
failing silently.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+Shift+S | Speak the selected text (or stop, if something is already being said) |
| Escape | Stop speech |

A short rising tone plays when speech starts and a falling one when it stops,
including for speech an agent started on its own.

## How it hangs together

`src/server/voice-operator.ts` is the only thing that knows where the service
lives and how it answers. Two callers sit on top of it:

- `src/server/direct-speech.ts` — text handed over already written: the MCP
  tool, the CLI, and the chord. One utterance at a time, plus a way to stop it.
- `src/server/summary-chat.ts` — the Summary Chat chord, which runs a model to
  produce what it speaks and keeps a per-surface conversation around it.

Both run on the server because Voice Operator is a local HTTP service and the
server is what talks to it. The renderer only plays the start/stop cues.
