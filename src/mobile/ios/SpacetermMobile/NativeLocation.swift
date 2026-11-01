import CoreLocation
import UIKit
import WebKit

/// The phone's position, for an agent that asked for the user's
/// (src/mobile/native-location.ts). Core Location rather than the web view's
/// `navigator.geolocation`, which asks again on every page load.
///
///   page → app:  `{id}`
///   app → page:  `spacetermNativeLocation.reply(id, {fix: {latitude, longitude, accuracyMeters, altitudeMeters?, timestamp}})`
///                or `spacetermNativeLocation.reply(id, {error})`
///
/// Asks for Always permission, in the foreground, the first time it is needed:
/// iOS shows "while using" first and offers Always later, or asks to upgrade
/// at once when "while using" is already granted. Always is what lets a
/// request be answered in the background — hands-free with the screen locked,
/// the app kept running by its audio — through the `location` background
/// mode, with the blue location indicator shown while it looks. Updates run
/// only from a request until its answer; nothing tracks the user between.
/// With only "while using", a request in the background fails at once, saying
/// to choose Always. Only a
/// sample taken after the request is answered with: Core Location hands back
/// its cached fix first, and a phone that has not moved can repeat it, so an
/// older timestamp is waited past. No fresh sample in time — in the
/// background, say, with the screen locked — is an error, never the last
/// known position: an agent told a stale place as current would be misled.
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
    /// When the current look began; a sample stamped before it is not fresh.
    private var lookingSince: Date?
    /// Clock slack between a sample's stamp and the request.
    private static let freshnessSlackSeconds = 1.0

    init(events: NativeEvents) {
        self.events = events
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.pausesLocationUpdatesAutomatically = false
        manager.showsBackgroundLocationIndicator = true
    }

    private var inForeground: Bool { UIApplication.shared.applicationState == .active }

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
            guard inForeground else {
                finish(error: "the Spaceterm app has not been given location permission yet; open it on the iPhone and the next request will ask")
                return
            }
            manager.requestAlwaysAuthorization()
        case .denied, .restricted:
            finish(error: "location permission is off for the Spaceterm app (Settings → Spaceterm → Location → Always)")
            return
        case .authorizedWhenInUse:
            guard inForeground else {
                finish(error: "the Spaceterm app may use location only while it is open, and it is in the background; set Settings → Spaceterm → Location → Always")
                return
            }
            // iOS asks the upgrade question once ever; later calls do nothing.
            manager.requestAlwaysAuthorization()
            startLooking()
        default:
            startLooking()
        }
        armTimeout()
    }

    /// Continuous updates rather than `requestLocation`, which delivers one
    /// sample — possibly the cached one — and stops.
    private func startLooking() {
        guard lookingSince == nil else { return }
        lookingSince = Date()
        // Needs the `location` background mode (Info.plist), or iOS traps.
        manager.allowsBackgroundLocationUpdates = true
        manager.startUpdatingLocation()
    }

    private func armTimeout() {
        timeout?.cancel()
        let item = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self, !self.waiting.isEmpty else { return }
                self.finish(error: "the iPhone could not get a fresh position in time (perhaps no GPS or Wi-Fi signal where it is)")
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
            default: startLooking()
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        MainActor.assumeIsolated {
            guard let since = lookingSince else { return }
            let earliest = since.addingTimeInterval(-Self.freshnessSlackSeconds)
            guard let fresh = locations.last(where: { $0.timestamp >= earliest && $0.horizontalAccuracy >= 0 }) else {
                if let stale = locations.last {
                    events.record("native-location-stale-sample", ["age": -stale.timestamp.timeIntervalSinceNow])
                }
                return
            }
            finish(fix: fresh)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let reason = error.localizedDescription
        // Core Location's word that it has nothing yet and is still trying.
        let stillTrying = (error as? CLError)?.code == .locationUnknown
        MainActor.assumeIsolated {
            if stillTrying {
                events.record("native-location-still-looking", ["error": reason])
                return
            }
            finish(error: "the iPhone could not find its position: \(reason)")
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
        if lookingSince != nil {
            manager.stopUpdatingLocation()
            manager.allowsBackgroundLocationUpdates = false
            lookingSince = nil
        }
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
