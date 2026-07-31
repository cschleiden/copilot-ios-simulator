import Foundation

final class Bridge {
    private let simctl = Simctl()
    private var hidControllers: [String: HIDController] = [:]

    func handle(_ envelope: CommandEnvelope) throws -> Any {
        switch envelope.method {
        case "diagnose":
            let probe = try XcodeProbe.resolve()
            try probe.validateLoadable()
            return ["xcode": probe.json()]
        case "listDevices":
            return try simctl.listDevices()
        case "boot":
            return try simctl.boot(try requiredString(envelope, "udid"))
        case "shutdown":
            return try simctl.shutdown(try requiredString(envelope, "udid"))
        case "setOrientation":
            let udid = try requiredString(envelope, "udid")
            let orientationName = try requiredString(envelope, "orientation")
            guard let orientation = DeviceOrientation(wireName: orientationName) else {
                throw BridgeError(code: "invalid_orientation", message: "Unsupported simulator orientation: \(orientationName)")
            }
            return try SimulatorOrientation.set(orientation, udid: udid)
        case "setHardwareKeyboard":
            let udid = try requiredString(envelope, "udid")
            return try SimulatorPreferences.setConnectHardwareKeyboard(
                try requiredBool(envelope, "connected"),
                udid: udid
            )
        case "sendKey":
            let udid = try requiredString(envelope, "udid")
            let code = try requiredString(envelope, "code")
            let modifiers = try stringArray(envelope, "modifiers")
            let phase = envelope.params?["phase"]?.stringValue ?? "press"
            return try hid(udid: udid).sendKey(code: code, modifiers: modifiers, phase: phase)
        case "sendText":
            let udid = try requiredString(envelope, "udid")
            return try hid(udid: udid).sendText(try requiredString(envelope, "text"))
        case "pressButton":
            let udid = try requiredString(envelope, "udid")
            return try hid(udid: udid).pressButton(try requiredString(envelope, "button"))
        case "tap":
            let udid = try requiredString(envelope, "udid")
            return try hid(udid: udid).tap(
                x: try requiredNumber(envelope, "x"),
                y: try requiredNumber(envelope, "y"),
                coordinateSpace: try requiredString(envelope, "coordinateSpace"),
                width: try requiredNumber(envelope, "width"),
                height: try requiredNumber(envelope, "height"),
                durationMs: envelope.params?["durationMs"]?.numberValue ?? 80
            )
        case "swipe":
            let udid = try requiredString(envelope, "udid")
            return try hid(udid: udid).swipe(
                startX: try requiredNumber(envelope, "startX"),
                startY: try requiredNumber(envelope, "startY"),
                endX: try requiredNumber(envelope, "endX"),
                endY: try requiredNumber(envelope, "endY"),
                coordinateSpace: try requiredString(envelope, "coordinateSpace"),
                width: try requiredNumber(envelope, "width"),
                height: try requiredNumber(envelope, "height"),
                durationMs: envelope.params?["durationMs"]?.numberValue ?? 250
            )
        case "touch":
            let udid = try requiredString(envelope, "udid")
            return try hid(udid: udid).touch(
                phase: try requiredString(envelope, "phase"),
                x: try requiredNumber(envelope, "x"),
                y: try requiredNumber(envelope, "y"),
                coordinateSpace: try requiredString(envelope, "coordinateSpace"),
                width: try requiredNumber(envelope, "width"),
                height: try requiredNumber(envelope, "height")
            )
        default:
            throw BridgeError(code: "unknown_method", message: "Unsupported bridge method: \(envelope.method)")
        }
    }

    private func requiredString(_ envelope: CommandEnvelope, _ key: String) throws -> String {
        guard let value = envelope.params?[key]?.stringValue, !value.isEmpty else {
            throw BridgeError(code: "invalid_params", message: "Missing required string parameter: \(key)")
        }
        return value
    }

    private func requiredNumber(_ envelope: CommandEnvelope, _ key: String) throws -> Double {
        guard let value = envelope.params?[key]?.numberValue else {
            throw BridgeError(code: "invalid_params", message: "Missing required number parameter: \(key)")
        }
        return value
    }

    private func requiredBool(_ envelope: CommandEnvelope, _ key: String) throws -> Bool {
        guard let value = envelope.params?[key]?.boolValue else {
            throw BridgeError(code: "invalid_params", message: "Missing required boolean parameter: \(key)")
        }
        return value
    }

    private func stringArray(_ envelope: CommandEnvelope, _ key: String) throws -> [String] {
        guard let values = envelope.params?[key]?.arrayValue else {
            return []
        }
        return values.compactMap(\.stringValue)
    }

    private func hid(udid: String) -> HIDController {
        if let existing = hidControllers[udid] {
            return existing
        }
        let created = HIDController(udid: udid)
        hidControllers[udid] = created
        return created
    }
}
