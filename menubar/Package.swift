// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "SpacetermBar",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "SpacetermBar",
            path: "Sources/SpacetermBar",
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
