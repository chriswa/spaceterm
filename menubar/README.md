# SpacetermBar

A macOS menu bar app that keeps Spaceterm running, so `npm run dev` in a
terminal is no longer part of the routine. It starts the server and the
client at login, restarts them when they ask to be restarted, brings them back
when they crash, and gives you a menu to start, stop and restart either half.

The icon is a crescent moon (the server) beside an angle brace (the client).
Each half is an outline or a thin stroke while its service is down and solid
while it is up. There are no badges beside the icon: the reasons for any state
live in the menu, and a pending server restart is already lit up on the client.

## Build

```bash
cd menubar
./bundle.sh          # build, install to ~/Applications, (re)launch
```

Needs Xcode's command line tools (Swift 6). No dependencies.

`./bundle.sh` stamps the app with the checkout it was built from, so the
installed app knows where Spaceterm is. To point an existing install
elsewhere:

```bash
defaults write local.spacetermbar SpacetermDirectory ~/somewhere/else/spaceterm
```

A value with no `package.json` behind it is ignored, and the menu says so.

## What it runs

Exactly what `npm run dev` runs, minus `concurrently` and the `sh -c 'while …'`
wrappers, which this app replaces:

| service | command | log |
|---|---|---|
| Server | `node node_modules/.bin/tsx src/server/index.ts` | `~/.spaceterm/bar-server.log` |
| Client | `node node_modules/.bin/electron-vite dev` | `~/.spaceterm/bar-client.log` |

Each is launched through `zsh -l -c 'exec …'`, so it gets the PATH a terminal
would (Homebrew's node is not on a GUI app's PATH), minus any agent-session
variables the bar itself inherited (`open SpacetermBar.app` from a Claude Code
shell forwards them, and passed on they make every Claude session in Spaceterm
think it is a nested child — see `Spawn.inheritedAgentSessionVars`), and in its own session
(`POSIX_SPAWN_SETSID`). The session is what makes the rest work:

- **Stop reaches the whole tree.** `tsx` forks the real server; `electron-vite`
  forks Electron, which forks its helpers. One `kill(-pgid, SIGTERM)` reaches
  all of them; nothing else on the machine is in that group. After 8 seconds
  anything still standing gets `SIGKILL`. The pty-daemon starts its own session
  and is never touched, so terminals survive a server stop, as they do today.
- **Spaceterm outlives the bar.** Quitting or relaunching SpacetermBar leaves
  the server and client running. Their pids are recorded in
  `~/.spaceterm/spaceterm-bar.json`, and the next instance adopts them — after
  checking that the pid is alive *and* its command line is still the
  service's, because pids get recycled and a stale record must never make the
  app signal a stranger.

## Restart policy

| exit | then |
|---|---|
| code 75 | relaunch immediately. This is `SERVER_RESTART_EXIT_CODE` / `CLIENT_RESTART_EXIT_CODE`; the client's ↻ Restart button ends here. |
| code 0 | stopped, and stays stopped. Cmd-Q on the client is not a crash. Start it again from the menu. |
| anything else | relaunch after 1s, 2s, 4s… (capped at 30s). Six crashes in a row without a stable minute in between and it stops trying, says so in the menu, and waits for you to press Start. |
| adopted process, status unknowable | treated as a restart request. |

## When something else started Spaceterm

If `npm run dev` is already running in a terminal, the menu says
"running outside SpacetermBar" and offers no buttons for that service. Two
servers would fight over `~/.spaceterm/bidirectional.sock`, so the app never
starts a second one, and it never signals a process it did not start.

## Menu

- Status of server and client, and the restart flag with its reason when one
  is raised (`npm run flag-restart -- "why"`; see `src/server/restart-flag.ts`).
- Start / Restart / Stop Spaceterm — both halves together.
- Start / Restart / Stop for the server and the client individually.
- Logs — the two supervisor logs and `electron.log`, opened in Console.
- **Start Spaceterm when SpacetermBar Opens** — on by default; this is what
  brings Spaceterm up at login.
- **Open on Login** — `SMAppService.mainApp`. macOS may answer
  `requiresApproval`; the menu then offers to open the right System Settings
  pane. Because registration resolves against the bundle's path, keep the app
  in `~/Applications` (where `bundle.sh` puts it).
- Restart SpacetermBar / Quit SpacetermBar — both keep Spaceterm running.
  Hold ⌥ for **Quit SpacetermBar and Stop Spaceterm**.

## Verifying from a terminal

```bash
.build/debug/SpacetermBar --probe        # what it sees: dir, node, who is running, pid file, flag
.build/debug/SpacetermBar --spawn-test   # supervisor against throwaway shell commands
.build/debug/SpacetermBar --watch        # print state transitions (adopts, does not start)
.build/debug/SpacetermBar --start --stop-after 60   # start both, stop after 60s, print transitions
.build/debug/SpacetermBar --icons ~/Desktop/icons   # PNGs of the icon
~/Applications/SpacetermBar.app/Contents/MacOS/SpacetermBar --login-status
```

`--spawn-test` covers what would otherwise need a keyboard: a tree dying
together on stop, exit 75 relaunching, backoff on a crash, exit 0 meaning
stopped, and restart() producing a new pid.

## Caveats

- Logging out ends the user session and everything in it, this app and
  Spaceterm included; login brings it all back if Open on Login is on.
- "Up" is detected without talking to the server: the socket file's
  modification time versus the process start (every connection is a peer to
  the server and gets announced to the other clients, so the app does not
  connect just to look). The client counts as up once Electron exists in its
  process group.
