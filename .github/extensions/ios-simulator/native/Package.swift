// swift-tools-version: 6.1

import PackageDescription

let package = Package(
    name: "IosSimulatorBridge",
    platforms: [.macOS(.v15)],
    products: [
        .executable(name: "SimulatorBridge", targets: ["SimulatorBridge"]),
    ],
    targets: [
        .executableTarget(
            name: "SimulatorBridge",
            path: "Sources/SimulatorBridge"
        ),
    ]
)
