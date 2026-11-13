import UIKit
import UserNotifications
import WebKit

/// Notifications of agents blocked on the user (src/mobile/block-alerts.ts).
///
///   page → app:  `{kind: "ready"}`, `{kind: "show", id, title, body}`, `{kind: "clear", id}`
///   app → page:  `window.spacetermNativeNotifications.tapped(id)`, `.lookingAt(id)`, `.pushToken(token)`
///
/// Most arrive through Apple, sent by the server (src/server/apns.ts), which
/// needs neither the page nor the app to be running; `show` is for when it
/// could not send one. Either way a notification carries its agent's node id,
/// and asking again replaces the last one rather than piling up. One instance
/// for the app's life: it must be the notification center's delegate before
/// launch finishes, which is before the web view exists.
@MainActor
final class NativeNotifications: NSObject, WKScriptMessageHandler, @preconcurrency UNUserNotificationCenterDelegate {
    static let shared = NativeNotifications()

    weak var webView: WKWebView?
    var events: NativeEvents?
    /// A tap the page has not taken yet: it launched the app, or the page is reloading.
    private var pendingTap: String?
    /// Apple's address for this phone, given to each page that loads.
    private var pushToken: String?

    private nonisolated static func nodeId(of request: UNNotificationRequest) -> String {
        request.content.userInfo["nodeId"] as? String ?? request.identifier
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let kind = body["kind"] as? String else { return }
        let center = UNUserNotificationCenter.current()
        switch kind {
        case "ready":
            center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
                DispatchQueue.main.async {
                    self.events?.record("native-notification", ["kind": "authorization", "granted": granted])
                    if granted { UIApplication.shared.registerForRemoteNotifications() }
                }
            }
            deliverPendingTap()
            deliverPushToken()
        case "show":
            guard let id = body["id"] as? String else { return }
            let content = UNMutableNotificationContent()
            content.title = body["title"] as? String ?? "Spaceterm"
            content.body = body["body"] as? String ?? ""
            content.sound = .default
            content.userInfo = ["nodeId": id, "always": body["always"] as? Bool == true]
            center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { error in
                DispatchQueue.main.async {
                    self.events?.record("native-notification", ["kind": "show", "error": error?.localizedDescription ?? ""])
                }
            }
        case "clear":
            guard let id = body["id"] as? String else { return }
            removeDelivered(nodeId: id) {}
            events?.record("native-notification", ["kind": "clear"])
        default:
            break
        }
    }

    /// The token Apple gave the app, or its reason for not giving one.
    func registered(token: String) {
        pushToken = token
        events?.record("native-notification", ["kind": "registered"])
        deliverPushToken()
    }

    func registrationFailed(_ error: Error) {
        events?.record("native-notification", ["kind": "registration-failed", "error": error.localizedDescription])
    }

    /// A quiet push: the prompt behind this notification has been answered elsewhere.
    func removeDelivered(nodeId: String, done: @escaping () -> Void) {
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { delivered in
            let matching = delivered.map(\.request).filter { Self.nodeId(of: $0) == nodeId }.map(\.identifier)
            center.removeDeliveredNotifications(withIdentifiers: matching)
            done()
        }
    }

    /// Shown with the app in front too, unless that terminal is what is on screen.
    /// One an agent sent on purpose (`always`, from `notify_user`) is shown regardless.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let alert: UNNotificationPresentationOptions = [.banner, .list, .sound]
        if notification.request.content.userInfo["always"] as? Bool == true { return completionHandler(alert) }
        guard let webView else { return completionHandler(alert) }
        webView.callAsyncJavaScript(
            "const page = window.spacetermNativeNotifications; return !!(page && page.lookingAt(id))",
            arguments: ["id": Self.nodeId(of: notification.request)], in: nil, in: .page
        ) { result in
            if case .success(let looking) = result, (looking as? Bool) == true { completionHandler([]) } else { completionHandler(alert) }
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        pendingTap = Self.nodeId(of: response.notification.request)
        events?.record("native-notification", ["kind": "tapped"])
        deliverPendingTap()
        completionHandler()
    }

    private func deliverPushToken() {
        guard let pushToken, let webView else { return }
        webView.callAsyncJavaScript(
            "const page = window.spacetermNativeNotifications; if (page) page.pushToken(token)",
            arguments: ["token": pushToken], in: nil, in: .page, completionHandler: nil
        )
    }

    private func deliverPendingTap() {
        guard let id = pendingTap, let webView else { return }
        webView.callAsyncJavaScript(
            "const page = window.spacetermNativeNotifications; if (!page) return false; page.tapped(id); return true",
            arguments: ["id": id], in: nil, in: .page
        ) { [weak self] result in
            if case .success(let taken) = result, (taken as? Bool) == true, self?.pendingTap == id { self?.pendingTap = nil }
        }
    }
}

/// What UIKit tells only an application delegate; SwiftUI has none of its own.
final class PushAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NativeNotifications.shared.registered(token: deviceToken.map { String(format: "%02x", $0) }.joined())
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NativeNotifications.shared.registrationFailed(error)
    }

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        guard let nodeId = userInfo["clearNodeId"] as? String else { return completionHandler(.noData) }
        NativeNotifications.shared.removeDelivered(nodeId: nodeId) { completionHandler(.newData) }
    }
}
