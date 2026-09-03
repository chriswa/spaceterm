import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {

    private var statusItem: NSStatusItem!
    private var controller: SpacetermController!
    /// One long-lived menu, repopulated in `menuNeedsUpdate` each time it
    /// opens, so login-item status and the restart flag are always fresh.
    private let statusMenu = NSMenu()

    func applicationDidFinishLaunching(_ notification: Notification) {
        controller = SpacetermController()
        controller.onChange = { [weak self] in self?.refreshUI() }

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        statusMenu.delegate = self
        statusItem.menu = statusMenu

        controller.begin(autoStart: Settings.startOnLaunch)
        refreshUI()
    }

    /// Quitting deliberately does NOT stop Spaceterm. The server and client
    /// run in their own sessions, and the next instance of this app adopts
    /// them from `~/.spaceterm/spaceterm-bar.json`. "Stop Spaceterm" is a
    /// separate, explicit menu item.
    func applicationWillTerminate(_ notification: Notification) {}

    // MARK: - Status item

    private func refreshUI() {
        guard let button = statusItem.button else { return }
        let up = { (s: ServiceSupervisor) in s.state.isUp || s.state.isExternal }
        button.image = BarIcon.image(serverUp: up(controller.server), clientUp: up(controller.client))
        // No badges. A down service is already visible as an outline in the
        // icon, and a pending restart is already lit up on the client itself;
        // the reasons live in the menu.
        button.title = ""
        button.imagePosition = .imageOnly
        button.toolTip = "Spaceterm: " + controller.services.map { "\($0.spec.title.lowercased()) \(Self.shortStatus($0))" }.joined(separator: ", ")
    }

    // MARK: - Menu

    func menuNeedsUpdate(_ menu: NSMenu) { rebuild(menu) }

    private func rebuild(_ menu: NSMenu) {
        menu.removeAllItems()

        // Status of each half.
        for s in controller.services {
            menu.addItem(header("\(s.spec.title): \(Self.longStatus(s))"))
        }
        if let flag = controller.restartFlag {
            let why = flag.reason.isEmpty ? "" : " — \(flag.reason)"
            menu.addItem(header("↻ Server restart flagged\(why)"))
        }
        menu.addItem(.separator())

        // Whole-of-Spaceterm actions.
        let anyOurs = controller.services.contains { $0.state.isOurs }
        let anyIdle = controller.services.contains { s in
            switch s.state { case .stopped, .failed, .restarting: return true; default: return false }
        }
        if anyIdle { add(menu, "Start Spaceterm", #selector(startAll), key: "s") }
        if anyOurs {
            add(menu, "Restart Spaceterm", #selector(restartAll), key: "r")
            add(menu, "Stop Spaceterm", #selector(stopAll))
        }
        menu.addItem(.separator())

        // Per-service actions.
        addServiceItems(menu, controller.server, start: #selector(startServer),
                        restart: #selector(restartServer), stop: #selector(stopServer))
        addServiceItems(menu, controller.client, start: #selector(startClient),
                        restart: #selector(restartClient), stop: #selector(stopClient))
        menu.addItem(.separator())

        // Logs and folder.
        let logs = NSMenu()
        let logItems: [(String, String)] = [
            ("Server Log (bar-server.log)", Settings.serverLogPath),
            ("Client Log (bar-client.log)", Settings.clientLogPath),
            ("Electron Log (electron.log)", Settings.electronLogPath),
        ]
        for (title, path) in logItems {
            let item = NSMenuItem(title: title, action: #selector(openPath(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = path
            item.isEnabled = FileManager.default.fileExists(atPath: path)
            logs.addItem(item)
        }
        logs.addItem(.separator())
        let folder = NSMenuItem(title: "Open ~/.spaceterm", action: #selector(openPath(_:)), keyEquivalent: "")
        folder.target = self
        folder.representedObject = Settings.stateDirectory
        logs.addItem(folder)
        let logsItem = NSMenuItem(title: "Logs", action: nil, keyEquivalent: "")
        logsItem.submenu = logs
        menu.addItem(logsItem)

        let dir = NSMenuItem(title: "Open Spaceterm Folder", action: #selector(openPath(_:)), keyEquivalent: "")
        dir.target = self
        dir.representedObject = controller.directory
        menu.addItem(dir)
        menu.addItem(header(abbreviateHome(controller.directory) + "  (\(controller.resolved.source))"))
        for problem in controller.resolved.problems { menu.addItem(header("⚠︎ ignored: " + problem)) }
        menu.addItem(.separator())

        // App.
        let autoStart = add(menu, "Start Spaceterm when SpacetermBar Opens", #selector(toggleStartOnLaunch))
        autoStart.state = Settings.startOnLaunch ? .on : .off

        let login = add(menu, LoginItem.menuTitle, #selector(toggleLoginItem), enabled: LoginItem.isInBundle)
        login.state = LoginItem.state.isChecked ? .on : .off
        if !LoginItem.isInBundle { login.toolTip = "Only available when running from SpacetermBar.app" }

        add(menu, "Restart SpacetermBar (keeps Spaceterm running)", #selector(relaunchSelf))
        add(menu, "Quit SpacetermBar (keeps Spaceterm running)", #selector(quit), key: "q")
        let quitAll = add(menu, "Quit SpacetermBar and Stop Spaceterm", #selector(quitAndStop), key: "q")
        quitAll.keyEquivalentModifierMask = [.command, .option]
        quitAll.isAlternate = true
    }

    private func addServiceItems(_ menu: NSMenu, _ s: ServiceSupervisor,
                                 start: Selector, restart: Selector, stop: Selector) {
        let t = s.spec.title
        switch s.state {
        case .stopped, .failed:
            add(menu, "Start \(t)", start)
        case .restarting:
            add(menu, "Retry \(t) Now", start)
            add(menu, "Stop \(t)", stop)
        case .starting:
            add(menu, "Stop \(t)", stop)
        case .running:
            add(menu, "Restart \(t)", restart)
            add(menu, "Stop \(t)", stop)
        case .stopping:
            add(menu, "Stopping \(t)…", nil, enabled: false)
        case .external:
            add(menu, "\(t) was started elsewhere (npm run dev?)", nil, enabled: false)
        }
    }

    // MARK: - Status text

    static func shortStatus(_ s: ServiceSupervisor) -> String {
        switch s.state {
        case .stopped:    return "off"
        case .starting:   return "starting"
        case .running:    return "up"
        case .stopping:   return "stopping"
        case .restarting: return "restarting"
        case .failed:     return "failed"
        case .external:   return "up (external)"
        }
    }

    static func longStatus(_ s: ServiceSupervisor) -> String {
        switch s.state {
        case .stopped:
            if let e = s.lastExit { return "stopped (\(e.label))" }
            return "stopped"
        case .starting(let pid):
            if let t = s.startingFor, t > Settings.slowStart {
                return "still starting after \(Int(t))s — pid \(pid), check the log"
            }
            return "starting… (pid \(pid))"
        case .running(let pid):        return "running (pid \(pid))"
        case .stopping(let pid):       return "stopping… (pid \(pid))"
        case .restarting(let why, let at):
            let secs = max(0, Int(at.timeIntervalSinceNow.rounded(.up)))
            return secs == 0 ? "\(why) — restarting" : "\(why) — retrying in \(secs)s"
        case .failed(let why):         return "failed — \(why)"
        case .external(let pid):       return "running outside SpacetermBar (pid \(pid))"
        }
    }

    // MARK: - Menu helpers

    private func header(_ text: String) -> NSMenuItem {
        let item = NSMenuItem(title: text, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    @discardableResult
    private func add(_ menu: NSMenu, _ title: String, _ action: Selector?,
                     key: String = "", enabled: Bool = true) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        item.isEnabled = enabled && action != nil
        menu.addItem(item)
        return item
    }

    private func abbreviateHome(_ path: String) -> String {
        let home = NSHomeDirectory()
        return path.hasPrefix(home) ? "~" + path.dropFirst(home.count) : path
    }

    // MARK: - Actions

    @objc private func startAll() {
        if let why = controller.startBlocker { warn("Cannot start Spaceterm", why); return }
        controller.startAll(); report()
    }
    @objc private func stopAll() { controller.stopAll() }
    @objc private func restartAll() { controller.restartAll() }

    @objc private func startServer() { warnIf(controller.startBlocker ?? controller.server.start()) }
    @objc private func stopServer() { controller.server.stop() }
    @objc private func restartServer() { controller.server.restart() }
    @objc private func startClient() { warnIf(controller.startBlocker ?? controller.client.start()) }
    @objc private func stopClient() { controller.client.stop() }
    @objc private func restartClient() { controller.client.restart() }

    /// A launch failure lands in the service's `failed` state, which the menu
    /// shows; this only surfaces the case where nothing could even be spawned.
    private func report() {
        for s in controller.services {
            if case .failed(let why) = s.state, why.hasPrefix("could not launch") {
                warn("Could not start the \(s.spec.title.lowercased())", why)
            }
        }
    }

    @objc private func openPath(_ sender: NSMenuItem) {
        guard let path = sender.representedObject as? String else { return }
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
    }

    @objc private func toggleStartOnLaunch() { Settings.startOnLaunch.toggle() }

    @objc private func toggleLoginItem() {
        if let error = LoginItem.toggle() {
            warn("Could not change login item", error)
        } else if LoginItem.state == .requiresApproval {
            let alert = NSAlert()
            alert.messageText = "Approval needed"
            alert.informativeText = "macOS needs you to enable SpacetermBar under "
                + "Login Items before it will launch at login."
            alert.addButton(withTitle: "Open System Settings")
            alert.addButton(withTitle: "Later")
            if alert.runModal() == .alertFirstButtonReturn { LoginItem.openSystemSettings() }
        }
    }

    /// Exit and come back. Spaceterm keeps running throughout and is adopted
    /// by the new instance. A detached shell waits for this pid to disappear
    /// before launching, so the two instances never overlap.
    @objc private func relaunchSelf() {
        let target = LoginItem.isInBundle ? Bundle.main.bundleURL.path : Bundle.main.executablePath!
        let script = "while kill -0 \(getpid()) 2>/dev/null; do sleep 0.2; done; "
            + (LoginItem.isInBundle ? "open '\(target)'" : "'\(target)' &")
        _ = try? Spawn.launch(argv: ["/bin/sh", "-c", script], cwd: "/",
                              log: Settings.stateDirectory + "/bar-relaunch.log", viaLoginShell: false)
        NSApp.terminate(nil)
    }

    @objc private func quit() { NSApp.terminate(nil) }

    @objc private func quitAndStop() {
        controller.stopAll()
        // Give SIGTERM a moment to be delivered and the stop to be recorded
        // before the process (and its escalation timers) go away. The group
        // kill on exit covers anything still standing.
        let deadline = Date().addingTimeInterval(1.0)
        while Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
        NSApp.terminate(nil)
    }

    private func warnIf(_ message: String?) { if let message { warn("Spaceterm", message) } }

    private func warn(_ title: String, _ detail: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        alert.alertStyle = .warning
        alert.runModal()
    }
}
