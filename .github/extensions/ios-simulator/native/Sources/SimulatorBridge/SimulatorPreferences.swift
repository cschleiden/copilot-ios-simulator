import Foundation
import ObjectiveC

enum SimulatorPreferences {
    static func setConnectHardwareKeyboard(_ connected: Bool, udid: String) throws -> [String: Any] {
        try setLiveHardwareKeyboard(connected, udid: udid)
        try setDeviceHardwareKeyboardLastSeen(connected, udid: udid)
        let domain = "com.apple.iphonesimulator" as CFString
        let key = udid as CFString
        let existing = CFPreferencesCopyAppValue(key, domain) as? [String: Any] ?? [:]
        var next = existing
        next["ConnectHardwareKeyboard"] = connected

        CFPreferencesSetAppValue(key, next as CFPropertyList, domain)
        guard CFPreferencesAppSynchronize(domain) else {
            throw BridgeError(
                code: "simulator_preferences_failed",
                message: "Failed to save Simulator keyboard preference for \(udid)."
            )
        }

        return [
            "udid": udid,
            "connectHardwareKeyboard": connected,
        ]
    }

    private static func setDeviceHardwareKeyboardLastSeen(_ connected: Bool, udid: String) throws {
        _ = try Shell.capture(
            "/usr/bin/xcrun",
            [
                "simctl",
                "spawn",
                udid,
                "defaults",
                "write",
                "com.apple.keyboard.preferences",
                "HardwareKeyboardLastSeen",
                "-bool",
                connected ? "YES" : "NO",
            ],
            timeoutSeconds: 10
        )
    }

    private static func setLiveHardwareKeyboard(_ connected: Bool, udid: String) throws {
        let device = try SimulatorRuntime.shared.device(udid: udid)
        let selector = NSSelectorFromString("setHardwareKeyboardEnabled:keyboardType:error:")
        guard device.responds(to: selector),
              let deviceClass = object_getClass(device),
              let implementation = class_getMethodImplementation(deviceClass, selector) else {
            throw BridgeError(
                code: "simulator_keyboard_unavailable",
                message: "CoreSimulator did not expose hardware keyboard control for \(udid)."
            )
        }

        typealias SetHardwareKeyboardFn = @convention(c) (
            AnyObject,
            Selector,
            ObjCBool,
            UInt8,
            AutoreleasingUnsafeMutablePointer<NSError?>
        ) -> ObjCBool

        var error: NSError?
        let success = unsafeBitCast(implementation, to: SetHardwareKeyboardFn.self)(
            device,
            selector,
            ObjCBool(connected),
            0,
            &error
        )
        guard success.boolValue else {
            throw BridgeError(
                code: "simulator_keyboard_failed",
                message: error?.localizedDescription ?? "CoreSimulator failed to update hardware keyboard state for \(udid)."
            )
        }
    }
}
