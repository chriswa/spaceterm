import Foundation

/// The two halves of Spaceterm as `npm run dev` runs them — `tsx
/// src/server/index.ts` and `electron-vite dev` — each under its own
/// supervisor, plus the polling, persistence and restart-flag reading that
/// spans both. An optional second client, started only from the menu, is a
/// third supervisor connecting to the same server.
@MainActor
final class SpacetermController {

    let server: ServiceSupervisor
    let client: ServiceSupervisor
    let secondClient: ServiceSupervisor
    /// Everything this app supervises.
    var services: [ServiceSupervisor] { [server, client, secondClient] }
    /// What "Spaceterm" means to Start Spaceterm, autostart and the icon. The
    /// second client is extra: it is started on request, never by default.
    var core: [ServiceSupervisor] { [server, client] }

    var onChange: (() -> Void)?

    private(set) var restartFlag: RestartFlag?
    private(set) var lastSnapshot: ProcessSnapshot?
    private var pollTimer: Timer?

    let directory: String
    let resolved: Settings.ResolvedDirectory

    init(resolved: Settings.ResolvedDirectory = Settings.resolveSpacetermDirectory()) {
        self.resolved = resolved
        self.directory = resolved.path
        server = ServiceSupervisor(spec: Self.serverSpec(directory))
        client = ServiceSupervisor(spec: Self.clientSpec(directory))
        secondClient = ServiceSupervisor(spec: Self.secondClientSpec(directory))
        for s in services {
            s.onChange = { [weak self] in
                self?.persist()
                self?.onChange?()
            }
        }
    }

    // MARK: - Specs

    /// The command lines are the absolute forms npm itself produces, so a
    /// server started by `npm run dev` in a terminal and one started here look
    /// the same in `ps`. The matchers deliberately ignore *which* checkout:
    /// the socket in `~/.spaceterm` is per user, so a server from any checkout
    /// is the one a second start would collide with.
    static func serverSpec(_ dir: String) -> ServiceSpec {
        let bin = dir + "/node_modules/.bin/tsx"
        return ServiceSpec(
            name: "server", title: "Server",
            argv: ["node", bin, "src/server/index.ts"],
            cwd: dir, logPath: Settings.serverLogPath, viaLoginShell: true,
            matches: { $0.contains("/node_modules/.bin/tsx") && $0.contains("src/server/index.ts") },
            // The server unlinks any stale socket and listens afresh, so a
            // socket file younger than the process means it is accepting.
            // A stat, deliberately, rather than a connect: every connection
            // is a peer to the server and is announced to the other clients.
            isUp: { _, startedAt, _ in
                let attrs = try? FileManager.default.attributesOfItem(atPath: Settings.serverSocketPath)
                guard let mtime = attrs?[.modificationDate] as? Date else { return false }
                return mtime >= startedAt.addingTimeInterval(-2)
            }
        )
    }

    static func clientSpec(_ dir: String) -> ServiceSpec {
        clientSpec(dir, name: "client", title: "Client", logPath: Settings.clientLogPath)
    }

    /// Another `electron-vite dev` against the same server. Its Vite dev
    /// server takes the next free port on its own; the DevTools port has to be
    /// moved by hand. It is not exclusive, so neither client mistakes the
    /// other for one started outside SpacetermBar.
    static func secondClientSpec(_ dir: String) -> ServiceSpec {
        var spec = clientSpec(dir, name: "client2", title: "Second Client",
                              logPath: Settings.secondClientLogPath)
        spec.env = ["SPACETERM_DEBUG_PORT": Settings.secondClientDebugPort]
        spec.exclusive = false
        return spec
    }

    private static func clientSpec(_ dir: String, name: String, title: String, logPath: String) -> ServiceSpec {
        let bin = dir + "/node_modules/.bin/electron-vite"
        let electron = dir + "/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
        return ServiceSpec(
            name: name, title: title,
            argv: ["node", bin, "dev"],
            cwd: dir, logPath: logPath, viaLoginShell: true,
            matches: { $0.contains("/node_modules/.bin/electron-vite") && $0.hasSuffix(" dev") },
            // electron-vite builds first and only then forks Electron; the
            // client is up once that Electron exists in the group.
            isUp: { pid, _, snapshot in
                let pgid = snapshot.row(pid: pid)?.pgid ?? pid
                return snapshot.group(pgid).contains { $0.command.hasPrefix(electron) }
            }
        )
    }

    // MARK: - Lifecycle

    /// Adopt what a previous instance left running, then poll. Call once.
    func begin(autoStart: Bool) {
        let snapshot = ProcessSnapshot.capture()
        adoptSurvivors(snapshot)
        tick(snapshot)

        if autoStart {
            for s in core where s.state == .stopped { s.start() }
        }

        let t = Timer(timeInterval: 2.0, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick(ProcessSnapshot.capture()) }
        }
        RunLoop.main.add(t, forMode: .common)
        pollTimer = t
    }

    /// Refuses, with the reason, when there is no checkout to start.
    var startBlocker: String? {
        resolved.isValid ? nil
            : "No Spaceterm checkout found. " + resolved.problems.joined(separator: "; ") + "."
    }

    func startAll() { core.forEach { $0.start() } }
    func stopAll() { services.forEach { $0.stop() } }
    /// Restarts the core, and the second client only if it is running.
    func restartAll() {
        core.forEach { $0.restart() }
        if secondClient.state.isOurs { secondClient.restart() }
    }

    func tick(_ snapshot: ProcessSnapshot) {
        lastSnapshot = snapshot
        let claimed = Set(services.compactMap(\.ownedGroup))
        services.forEach { $0.tick(snapshot, claimed: claimed) }
        let flag = RestartFlag.read()
        if flag != restartFlag {
            restartFlag = flag
            onChange?()
        }
    }

    // MARK: - Survivors

    /// A record is trusted only if the pid is alive *and* its command line is
    /// the service's. Pids are recycled; a stale record must never make us
    /// signal a stranger.
    private func adoptSurvivors(_ snapshot: ProcessSnapshot) {
        guard let data = FileManager.default.contents(atPath: Settings.supervisedPath),
              let records = try? JSONDecoder().decode([String: SupervisedRecord].self, from: data)
        else { return }
        for s in services {
            guard let r = records[s.spec.name], let row = snapshot.row(pid: r.pid),
                  s.spec.matches(row.command) else { continue }
            s.adopt(pid: r.pid, pgid: row.pgid, startedAt: Date(timeIntervalSince1970: r.startedAt))
        }
    }

    private func persist() {
        var records: [String: SupervisedRecord] = [:]
        for s in services { if let r = s.record { records[s.spec.name] = r } }
        let url = URL(fileURLWithPath: Settings.supervisedPath)
        if records.isEmpty {
            try? FileManager.default.removeItem(at: url)
        } else if let data = try? JSONEncoder().encode(records) {
            try? FileManager.default.createDirectory(atPath: Settings.stateDirectory,
                                                     withIntermediateDirectories: true)
            try? data.write(to: url, options: .atomic)
        }
    }

    // MARK: - Summary

    enum Overall: Equatable { case off, partial, up, failed }

    var overall: Overall {
        if core.contains(where: { $0.state.isFailed }) { return .failed }
        let up = core.filter { $0.state.isUp || $0.state.isExternal }.count
        let live = core.filter { $0.state != .stopped }.count
        if up == core.count { return .up }
        if live == 0 { return .off }
        return .partial
    }
}

/// `~/.spaceterm/restart-required.json`, written by `npm run flag-restart`
/// (see `src/server/restart-flag.ts`). Presence means an agent changed
/// something the running server will not pick up until it is restarted.
struct RestartFlag: Equatable {
    let reason: String
    let requestedAt: Date

    static func read(path: String = Settings.restartFlagPath) -> RestartFlag? {
        guard let data = FileManager.default.contents(atPath: path) else { return nil }
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let reason = obj?["reason"] as? String ?? ""
        let ms = obj?["requestedAt"] as? Double ?? 0
        return RestartFlag(reason: reason, requestedAt: Date(timeIntervalSince1970: ms / 1000))
    }
}
