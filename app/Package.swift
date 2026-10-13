// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "DevLocal",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "DevLocal", targets: ["DevLocal"]),
    ],
    targets: [
        // Everything that can be tested without AppKit: the model, the menu logic and the
        // parsers for the things the menu reads from the system.
        .target(
            name: "DevLocalCore",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        // The UI shell: the status item, the server process and the windows. Swift 5 mode,
        // since AppKit callbacks fight strict Sendable checking.
        .executableTarget(
            name: "DevLocal",
            dependencies: ["DevLocalCore"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "DevLocalCoreTests",
            dependencies: ["DevLocalCore"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
