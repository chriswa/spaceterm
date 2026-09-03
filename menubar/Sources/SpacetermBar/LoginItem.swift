import Foundation
import ServiceManagement

/// Registers the app itself as a login item via SMAppService (macOS 13+).
/// `mainApp` refers to this bundle, so registration is a single call — but it
/// resolves against the bundle's *location*, which is why `bundle.sh`
/// installs to a fixed path under ~/Applications.
enum LoginItem {

    enum State {
        case enabled
        case disabled
        /// Registered, but the user must approve it in System Settings →
        /// General → Login Items. macOS decides this, not the app.
        case requiresApproval

        var isChecked: Bool { self == .enabled }
    }

    static var state: State {
        switch SMAppService.mainApp.status {
        case .enabled:          return .enabled
        case .requiresApproval: return .requiresApproval
        // `.notFound` is what a never-registered bundle reports, and
        // register() succeeds from it — so it is "off", not "broken".
        case .notRegistered, .notFound: return .disabled
        @unknown default:       return .disabled
        }
    }

    /// Flips registration. Returns nil on success, or a message to show.
    @discardableResult
    static func toggle() -> String? {
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    static func openSystemSettings() { SMAppService.openSystemSettingsLoginItems() }

    static var menuTitle: String {
        state == .requiresApproval ? "Open on Login (needs approval)" : "Open on Login"
    }

    static var isInBundle: Bool { Bundle.main.bundleURL.pathExtension == "app" }
}
