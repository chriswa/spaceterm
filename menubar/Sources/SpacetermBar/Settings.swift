import Foundation

/// Where Spaceterm lives and how the supervisor behaves.
///
/// The checkout directory is the one real setting. It is resolved, in order,
/// from a `SpacetermDirectory` user default (`defaults write local.spacetermbar
/// SpacetermDirectory /path`), the same key in the bundle's Info.plist (which
/// `bundle.sh` stamps with the repo it was built from), and finally
/// `~/spaceterm`.
enum Settings {

    static let bundleIdentifier = "local.spacetermbar"

    /// The checkout, and where that answer came from. Candidates are tried in
    /// order and the first that actually contains a `package.json` wins; the
    /// ones skipped are reported so a typo'd `defaults write` shows up in the
    /// menu instead of as a launch failure deep inside posix_spawn.
    struct ResolvedDirectory {
        let path: String
        let source: String
        /// Human-readable notes about candidates that were rejected.
        let problems: [String]
        /// True when even the winning candidate has no package.json.
        let isValid: Bool
    }

    static func resolveSpacetermDirectory() -> ResolvedDirectory {
        var candidates: [(path: String, source: String)] = []
        if let d = UserDefaults.standard.string(forKey: "SpacetermDirectory"), !d.isEmpty {
            candidates.append((NSString(string: d).expandingTildeInPath, "defaults SpacetermDirectory"))
        }
        if let d = Bundle.main.object(forInfoDictionaryKey: "SpacetermDirectory") as? String, !d.isEmpty {
            candidates.append((NSString(string: d).expandingTildeInPath, "Info.plist"))
        }
        candidates.append((NSString(string: "~/spaceterm").expandingTildeInPath, "default ~/spaceterm"))

        var problems: [String] = []
        for c in candidates {
            if FileManager.default.fileExists(atPath: c.path + "/package.json") {
                return ResolvedDirectory(path: c.path, source: c.source, problems: problems, isValid: true)
            }
            problems.append("\(c.source) = \u{201C}\(c.path)\u{201D} has no package.json")
        }
        let last = candidates[candidates.count - 1]
        return ResolvedDirectory(path: last.path, source: last.source, problems: problems, isValid: false)
    }

    static var spacetermDirectory: String { resolveSpacetermDirectory().path }

    /// `~/.spaceterm` — the server's socket directory, and where this app keeps
    /// its logs and the record of which processes it is supervising.
    static let stateDirectory = NSString(string: "~/.spaceterm").expandingTildeInPath

    static var serverSocketPath: String { stateDirectory + "/bidirectional.sock" }
    static var restartFlagPath: String { stateDirectory + "/restart-required.json" }
    static var supervisedPath: String { stateDirectory + "/spaceterm-bar.json" }
    static var serverLogPath: String { stateDirectory + "/bar-server.log" }
    static var clientLogPath: String { stateDirectory + "/bar-client.log" }
    static var electronLogPath: String { stateDirectory + "/electron.log" }

    /// Start the server and client as soon as the app launches (so a login
    /// launch brings Spaceterm up). Default on; a checkbox in the menu.
    static var startOnLaunch: Bool {
        get { UserDefaults.standard.object(forKey: "StartOnLaunch") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "StartOnLaunch") }
    }

    /// Both services exit with this code to ask their supervisor for an
    /// immediate relaunch — `SERVER_RESTART_EXIT_CODE` in `src/server/index.ts`
    /// and `CLIENT_RESTART_EXIT_CODE` in `src/client/main/index.ts`. The
    /// client's ↻ Restart button ends here.
    static let restartExitCode: Int32 = 75

    /// After SIGTERM, how long a service gets to exit before its whole
    /// process group is SIGKILLed.
    static let stopGrace: TimeInterval = 8

    /// A crash is retried after 1s, 2s, 4s… capped here. The backoff resets
    /// once a process has stayed up for `stableAfter`.
    static let maxCrashBackoff: TimeInterval = 30
    static let stableAfter: TimeInterval = 60

    /// This many crashes without a stable run in between means something is
    /// actually broken; the supervisor stops retrying and says so.
    static let maxConsecutiveCrashes = 6

    /// A service that has been "starting" this long without coming up is
    /// reported as such in the menu, but not killed — a cold `electron-vite`
    /// build can be slow, and a hung start is a thing to look at, not hide.
    static let slowStart: TimeInterval = 45

    /// Log files are truncated when they pass this size, at the next start.
    static let maxLogBytes: UInt64 = 20 * 1024 * 1024
}
