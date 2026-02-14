# Text-to-Speech Setup

Spaceterm can read selected terminal text aloud using macOS native TTS. Select text in a terminal and press **Cmd+Shift+S** to start/stop speech. **Escape** also stops playback.

## Installing a Premium Voice (Zoe)

The app ships with compact (low-quality) voices. For the best experience, download the **Zoe (Premium)** voice:

1. Open **System Settings**
2. Go to **Accessibility** → **Spoken Content**
3. Click the **System Voice** dropdown
4. Select **Manage Voices...**
5. In the voice list, find **English (US)** → **Zoe**
6. Click the download button next to **Zoe (Premium)** (not Enhanced or Compact)
7. Wait for the download to complete (~300-500 MB)
8. Close System Settings and restart Spaceterm

The app automatically detects and prefers premium voices. No configuration needed — once Zoe (Premium) is installed, it will be used automatically.

## Voice Quality Tiers

macOS voices come in three quality levels:

| Tier | Size | Quality |
|------|------|---------|
| Compact | Pre-installed | Low — robotic, noticeable artifacts |
| Enhanced | ~100-200 MB | Good — natural sounding |
| Premium | ~300-500 MB | Best — neural TTS, very natural |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+Shift+S | Speak selected text (or stop if already speaking) |
| Escape | Stop speech |
