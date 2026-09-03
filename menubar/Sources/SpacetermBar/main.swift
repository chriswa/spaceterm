import AppKit

/// NSApplication.delegate is weak, so the delegate needs an owner that
/// outlives launch.
private var retainedDelegate: AnyObject?

/// `SpacetermBar --probe` prints what the app sees and exits: where Spaceterm
/// is, what node the login shell resolves, what is running and who owns it.
@MainActor
private func runProbe() -> Never {
    let resolved = Settings.resolveSpacetermDirectory()
    let dir = resolved.path
    print("spaceterm  : \(dir)  [\(resolved.source)]" + (resolved.isValid ? "" : "  (NO package.json!)"))
    for p in resolved.problems { print("  ignored  : \(p)") }
    print("node       : \(Shell.loginShellNode() ?? "NOT FOUND in a login shell")")
    // The same login-shell + exec path the services use, against the real tsx.
    let tsx = Shell.run("/bin/zsh", ["-l", "-c", "exec node '\(dir)/node_modules/.bin/tsx' --version"])
    print("tsx        : " + (tsx.status == 0 ? tsx.out.trimmingCharacters(in: .whitespacesAndNewlines) : "FAILED (exit \(tsx.status))"))
    print("state dir  : \(Settings.stateDirectory)")
    print("bundle     : \(Bundle.main.bundleURL.path)" + (LoginItem.isInBundle ? "" : "  (bare binary — login item unavailable)"))

    let snapshot = ProcessSnapshot.capture()
    let c = SpacetermController(resolved: resolved)
    for s in c.services {
        if let row = snapshot.first(where: s.spec.matches) {
            print("\(s.spec.title.padding(toLength: 11, withPad: " ", startingAt: 0)): pid \(row.pid) pgid \(row.pgid)  \(row.command.prefix(90))")
        } else {
            print("\(s.spec.title.padding(toLength: 11, withPad: " ", startingAt: 0)): not running")
        }
    }
    if let data = FileManager.default.contents(atPath: Settings.supervisedPath),
       let text = String(data: data, encoding: .utf8) {
        print("supervised : \(text)")
    } else {
        print("supervised : none recorded")
    }
    let sock = Settings.serverSocketPath
    print("socket     : " + (FileManager.default.fileExists(atPath: sock) ? sock : "absent"))
    if let flag = RestartFlag.read() {
        print("restart flag: \(flag.reason.isEmpty ? "(no reason)" : flag.reason)  at \(flag.requestedAt)")
    } else {
        print("restart flag: none")
    }
    exit(0)
}

/// `--watch` prints every state transition of the same controller the menu
/// uses, adopting and (with `--start`) starting exactly as the app would.
@MainActor
private func runHeadless(start: Bool, stopAfter: TimeInterval?) -> Never {
    setvbuf(stdout, nil, _IOLBF, 0)
    let c = SpacetermController()
    let began = Date()
    func stamp() -> String { String(format: "%6.1fs", Date().timeIntervalSince(began)) }
    var last = ""
    c.onChange = {
        let now = c.services.map { "\($0.spec.title.lowercased()): \(AppDelegate.longStatus($0))" }.joined(separator: "   |   ")
        if now != last { print("\(stamp())  \(now)"); last = now }
    }
    c.begin(autoStart: start)
    c.onChange?()
    if let stopAfter {
        let t = Timer(timeInterval: stopAfter, repeats: false) { _ in
            MainActor.assumeIsolated { print("\(stamp())  stopping…"); c.stopAll() }
        }
        RunLoop.main.add(t, forMode: .common)
    }
    while true {
        RunLoop.main.run(until: Date().addingTimeInterval(1))
        if stopAfter != nil, Date().timeIntervalSince(began) > stopAfter! + 2,
           c.services.allSatisfy({ $0.state == .stopped }) {
            print("\(stamp())  all stopped"); exit(0)
        }
    }
}

/// `--spawn-test` exercises the supervisor against throwaway shell commands
/// instead of Spaceterm: group kill of a small tree, restart on exit 75,
/// backoff on a crash, and exit 0 meaning "stopped".
@MainActor
private func runSpawnTest() -> Never {
    setvbuf(stdout, nil, _IOLBF, 0)
    let log = FileManager.default.temporaryDirectory.appendingPathComponent("spawn-test.log").path
    var failures = 0
    func check(_ ok: Bool, _ what: String) {
        print((ok ? "  ok   " : "  FAIL ") + what)
        if !ok { failures += 1 }
    }
    func spec(_ name: String, _ cmd: String, isUp: @escaping (pid_t, Date, ProcessSnapshot) -> Bool = { _, _, _ in true }) -> ServiceSpec {
        ServiceSpec(name: name, title: name, argv: ["/bin/sh", "-c", cmd], cwd: "/", logPath: log,
                    viaLoginShell: false, matches: { _ in false }, isUp: isUp)
    }
    func run(_ seconds: TimeInterval) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }

    print("1. a tree (sh + two sleeps) dies together on stop")
    let tree = ServiceSupervisor(spec: spec("tree", "sleep 300 & sleep 300 & wait"))
    tree.start()
    run(0.5)
    tree.tick(ProcessSnapshot.capture())
    guard case .running(let pid) = tree.state else { print("  FAIL not running: \(tree.state)"); exit(1) }
    let members = ProcessSnapshot.capture().group(pid)
    check(members.count >= 3, "group \(pid) has \(members.count) members (leader + 2 sleeps)")
    tree.stop()
    run(1.0)
    check(tree.state == .stopped, "state after stop: \(tree.state)")
    check(ProcessSnapshot.capture().group(pid).isEmpty, "group \(pid) is empty")

    print("2. exit 75 restarts immediately")
    var seen: [ServiceState] = []
    let r75 = ServiceSupervisor(spec: spec("r75", "exit 75"))
    r75.onChange = { seen.append(r75.state) }
    r75.start()
    run(1.0)
    let restarted = seen.contains { if case .restarting(let why, _) = $0 { return why == "restart requested" }; return false }
    check(restarted, "went through 'restart requested' (\(seen.count) transitions)")
    r75.stop()

    print("3. exit 3 backs off, and gives up after \(Settings.maxConsecutiveCrashes)")
    seen = []
    let crash = ServiceSupervisor(spec: spec("crash", "exit 3"))
    crash.onChange = { seen.append(crash.state) }
    crash.start()
    run(2.5)
    let backoffs = seen.compactMap { s -> Date? in if case .restarting(_, let at) = s { return at }; return nil }
    check(backoffs.count >= 2, "scheduled \(backoffs.count) retries so far")
    if backoffs.count >= 2 {
        let gap = backoffs[1].timeIntervalSince(backoffs[0])
        check(gap > 1.8 && gap < 2.6, String(format: "second retry %.1fs after the first (1s, then 2s)", gap))
    }
    crash.stop()

    print("4. exit 0 is a stop, not a crash")
    let clean = ServiceSupervisor(spec: spec("clean", "exit 0"))
    clean.start()
    run(0.7)
    check(clean.state == .stopped, "state: \(clean.state)")

    print("5. restart() on a running service brings it back with a new pid")
    let rs = ServiceSupervisor(spec: spec("rs", "sleep 300"))
    rs.start()
    run(0.3)
    let firstPid = rs.state.pid
    rs.restart()
    run(1.5)
    rs.tick(ProcessSnapshot.capture())
    check(rs.state.isUp && rs.state.pid != firstPid, "was \(firstPid ?? 0), now \(rs.state)")
    rs.stop()
    run(0.5)

    print(failures == 0 ? "all passed" : "\(failures) failure(s)")
    exit(failures == 0 ? 0 : 1)
}

private func runIcons(_ dir: String) -> Never {
    let url = URL(fileURLWithPath: NSString(string: dir).expandingTildeInPath)
    MainActor.assumeIsolated {
        for h in [16, 32, 128] as [CGFloat] { BarIcon.writePreviews(to: url, height: h) }
    }
    print("wrote previews to \(url.path)")
    exit(0)
}

private func runLoginStatus() -> Never {
    print("bundle     : \(Bundle.main.bundleURL.path)")
    print("in .app    : \(LoginItem.isInBundle)")
    print("state      : \(LoginItem.state)")
    print("menu title : \(LoginItem.menuTitle)")
    exit(0)
}

let args = CommandLine.arguments
if args.contains("--probe") { MainActor.assumeIsolated { runProbe() } }
if args.contains("--login-status") { runLoginStatus() }
if args.contains("--spawn-test") { MainActor.assumeIsolated { runSpawnTest() } }
if let i = args.firstIndex(of: "--icons"), i + 1 < args.count { runIcons(args[i + 1]) }
if args.contains("--watch") || args.contains("--start") {
    var stopAfter: TimeInterval? = nil
    if let i = args.firstIndex(of: "--stop-after"), i + 1 < args.count { stopAfter = TimeInterval(args[i + 1]) }
    MainActor.assumeIsolated { runHeadless(start: args.contains("--start"), stopAfter: stopAfter) }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    // Menu bar only: no Dock icon, no app switcher entry.
    app.setActivationPolicy(.accessory)
    let delegate = AppDelegate()
    retainedDelegate = delegate
    app.delegate = delegate
    app.run()
}
