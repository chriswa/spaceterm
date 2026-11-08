import UserNotifications
import WebKit

/// Notifications of agents blocked on the user (src/mobile/block-alerts.ts).
///
///   page → app:  `{kind: "ready"}`, `{kind: "show", id, title, body}`, `{kind: "clear", id}`
///   app → page:  `window.spacetermNativeNotifications.tapped(id)`
///
/// A notification's identifier is its agent's node id, so asking again
/// replaces the last one rather than piling up. One instance for the app's
/// life: it must be the notification center's delegate before launch finishes,
/// which is before the web view exists.
@MainActor
final class NativeNotifications: NSObject, WKScriptMessageHandler, @preconcurrency UNUserNotificationCenterDelegate {
    static let shared = NativeNotifications()

    weak var webView: WKWebView?
    var events: NativeEvents?
    /// A tap the page has not taken yet: it launched the app, or the page is reloading.
    private var pendingTap: String?

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let kind = body["kind"] as? String else { return }
        let center = UNUserNotificationCenter.current()
        switch kind {
        case "ready":
            center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
                DispatchQueue.main.async {
                    self.events?.record("native-notification", ["kind": "authorization", "granted": granted])
                }
            }
            deliverPendingTap()
        case "show":
            guard let id = body["id"] as? String else { return }
            let content = UNMutableNotificationContent()
            content.title = body["title"] as? String ?? "Spaceterm"
            content.body = body["body"] as? String ?? ""
            content.sound = .default
            center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { error in
                DispatchQueue.main.async {
                    self.events?.record("native-notification", ["kind": "show", "error": error?.localizedDescription ?? ""])
                }
            }
        case "clear":
            guard let id = body["id"] as? String else { return }
            center.removeDeliveredNotifications(withIdentifiers: [id])
            events?.record("native-notification", ["kind": "clear"])
        default:
            break
        }
    }

    /// Shown with the app in front too: it may be on the canvas, or another agent.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        pendingTap = response.notification.request.identifier
        events?.record("native-notification", ["kind": "tapped"])
        deliverPendingTap()
        completionHandler()
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
