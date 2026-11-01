import CoreLocation
import WebKit

/// The phone's position, for an agent that asked for the user's
/// (src/mobile/native-location.ts). Core Location rather than the web view's
/// `navigator.geolocation`, which asks again on every page load and has no
/// last-known fix to fall back on in the background.
///
///   page → app:  `{id}`
///   app → page:  `spacetermNativeLocation.reply(id, {fix: {latitude, longitude, accuracyMeters, altitudeMeters?, timestamp}})`
///                or `spacetermNativeLocation.reply(id, {error})`
///
/// Asks for "while using" permission the first time it is needed. A request
/// made while the app is in the background (hands-free with the screen
/// locked) usually cannot get a fresh fix, so it falls back on the last one
/// iOS has, whose `timestamp` says how old it is.
@MainActor
final class NativeLocation: NSObject, WKScriptMessageHandler, CLLocationManagerDelegate {
    weak var webView: WKWebView?
    private let events: NativeEvents
    private let manager = CLLocationManager()
    /// Requests waiting for a fix, or for permission to look for one.
    private var waiting: [String] = []
    private var timeout: DispatchWorkItem?
    /// Under the page's own limit (NATIVE_TIMEOUT_MS), so it hears why.
    private static let timeoutSeconds = 14.0
    /// A last-known fix older than this is not offered when a fresh one fails.
    private static let staleSeconds = 30.0 * 60

    init(events: NativeEvents) {
        self.events = events
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
    }

    nonisolated func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated {
            guard let body = message.body as? [String: Any], let id = body["id"] as? String else { return }
            request(id)
        }
    }

    private func request(_ id: String) {
        events.record("native-location-request", ["authorization": Self.describe(manager.authorizationStatus)])
        waiting.append(id)
        switch manager.authorizationStatus {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .denied, .restricted:
            finish(error: "location permission is off for the Spaceterm app (Settings → Spaceterm → Location)")
            return
        default:
            manager.requestLocation()
        }
        armTimeout()
    }

    private func armTimeout() {
        timeout?.cancel()
        let item = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self, !self.waiting.isEmpty else { return }
                self.finishWithLastKnown(or: "the iPhone could not find its position in time")
            }
        }
        timeout = item
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.timeoutSeconds, execute: item)
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        MainActor.assumeIsolated {
            guard !waiting.isEmpty else { return }
            switch manager.authorizationStatus {
            case .notDetermined: return
            case .denied, .restricted: finish(error: "location permission was denied on the iPhone")
            default: manager.requestLocation()
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        MainActor.assumeIsolated { finish(fix: location) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let reason = error.localizedDescription
        MainActor.assumeIsolated {
            events.record("native-location-failed", ["error": reason])
            finishWithLastKnown(or: "the iPhone could not find its position: \(reason)")
        }
    }

    /// The last fix iOS has, when there is a recent one; otherwise the error.
    private func finishWithLastKnown(or error: String) {
        if let last = manager.location, -last.timestamp.timeIntervalSinceNow < Self.staleSeconds {
            finish(fix: last)
        } else {
            finish(error: error)
        }
    }

    private func finish(fix location: CLLocation) {
        var fix: [String: Any] = [
            "latitude": location.coordinate.latitude,
            "longitude": location.coordinate.longitude,
            "accuracyMeters": location.horizontalAccuracy,
            "timestamp": (location.timestamp.timeIntervalSince1970 * 1000).rounded(),
        ]
        if location.verticalAccuracy >= 0 { fix["altitudeMeters"] = location.altitude }
        events.record("native-location-fix", ["accuracy": location.horizontalAccuracy, "age": -location.timestamp.timeIntervalSinceNow])
        reply(["fix": fix])
    }

    private func finish(error: String) {
        events.record("native-location-failed", ["error": error])
        reply(["error": error])
    }

    private func reply(_ answer: [String: Any]) {
        timeout?.cancel()
        timeout = nil
        let ids = waiting
        waiting.removeAll()
        guard let data = try? JSONSerialization.data(withJSONObject: answer),
              let json = String(data: data, encoding: .utf8) else { return }
        for id in ids {
            let quoted = (try? JSONSerialization.data(withJSONObject: [id])).flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
            webView?.evaluateJavaScript(
                "window.spacetermNativeLocation && window.spacetermNativeLocation.reply(\(quoted)[0], \(json)), 0",
                completionHandler: nil)
        }
    }

    private static func describe(_ status: CLAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: return "not-determined"
        case .restricted: return "restricted"
        case .denied: return "denied"
        case .authorizedAlways: return "always"
        case .authorizedWhenInUse: return "when-in-use"
        @unknown default: return "unknown"
        }
    }
}
