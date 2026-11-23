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
    static var secondClientLogPath: String { stateDirectory + "/bar-client2.log" }

    /// The second client's DevTools port. The first keeps 9222, the default
    /// in `src/client/main/index.ts`; two Chromiums cannot share a port.
    static let secondClientDebugPort = "9223"
    static var electronLogPath: String { stateDirectory + "/electron.log" }

    /// Start the server and client as soon as the app launches (so a login
    /// launch brings Spaceterm up). Default on; a checkbox in the menu.
    static var startOnLaunch: Bool {
        get { UserDefaults.standard.object(forKey: "StartOnLaunch") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "StartOnLaunch") }
    }

    /// How big an agent's context may be for Control to wake it from a cold
    /// cache without checking with the user first: advice Control sees in its
    /// cache lines, not a gate. Per machine, because what a wake costs depends
    /// on how much Claude usage the machine has to spend. Kept in
    /// `~/.spaceterm/control.json`, where the server reads it each time
    /// (`src/server/receptionist/wake-limit.ts`, which must agree on the key,
    /// the choices and the default), so a change applies without a restart.
    static var controlSettingsPath: String { stateDirectory + "/control.json" }
    static let wakeLimitKey = "wakeWithoutAskingTokens"
    /// `nil` is No limit: any cold agent may be woken without asking. Stored as JSON `null`.
    static let wakeLimitChoices: [Int?] = [0, 100_000, 250_000, 500_000, nil]
    /// No limit when nothing is set, as the server assumes.
    static let defaultWakeLimit: Int? = nil

    static var wakeLimit: Int? {
        get {
            let value = readControlSettings()[wakeLimitKey]
            if value is NSNull { return nil }
            guard let number = value as? NSNumber, number.intValue >= 0 else { return defaultWakeLimit }
            return number.intValue
        }
        set {
            // Other keys in the file are the server's business: kept as found.
            var settings = readControlSettings()
            settings[wakeLimitKey] = newValue.map { $0 as Any } ?? NSNull()
            guard let data = try? JSONSerialization.data(withJSONObject: settings, options: [.prettyPrinted, .sortedKeys]) else { return }
            try? FileManager.default.createDirectory(atPath: stateDirectory, withIntermediateDirectories: true)
            try? data.write(to: URL(fileURLWithPath: controlSettingsPath), options: .atomic)
        }
    }

    private static func readControlSettings() -> [String: Any] {
        guard let data = FileManager.default.contents(atPath: controlSettingsPath),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return object
    }

    /// Both services exit with this code to ask their supervisor for an
    /// immediate relaunch — `SERVER_RESTART_EXIT_CODE` in `src/server/relaunch.ts`
    /// (only where Node cannot relaunch in place) and `CLIENT_RESTART_EXIT_CODE` in `src/client/main/index.ts`. The
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
