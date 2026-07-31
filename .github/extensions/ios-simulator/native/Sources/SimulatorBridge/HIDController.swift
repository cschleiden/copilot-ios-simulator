import Darwin
import Foundation
import CoreGraphics
import ObjectiveC

struct HIDUsage {
    let page: UInt32
    let usage: UInt32
}

final class HIDController {
    private typealias HIDArbitraryFn = @convention(c) (UInt32, UInt32, UInt32, UInt32) -> UnsafeMutableRawPointer?
    private typealias ButtonFn = @convention(c) (UInt32, UInt32, UInt32) -> UnsafeMutableRawPointer?
    private typealias MouseFn = @convention(c) (
        UnsafePointer<CGPoint>, UnsafePointer<CGPoint>?,
        UInt32, UInt32, UInt32,
        Double, Double,
        Double, Double
    ) -> UnsafeMutableRawPointer?

    private static let digitizerTarget: UInt32 = 0x32
    private static let buttonTarget: UInt32 = 0x33
    private static let eventDown: UInt32 = 1
    private static let eventUp: UInt32 = 2
    private static let eventDragged: UInt32 = 6
    private static let directionMove: UInt32 = 0
    private static let directionDown: UInt32 = 1
    private static let directionUp: UInt32 = 2

    private let udid: String
    private let runtime = SimulatorRuntime.shared
    private var client: AnyObject?

    init(udid: String) {
        self.udid = udid
    }

    func sendKey(code: String, modifiers: [String], phase: String) throws -> [String: Any] {
        let usage = try keyUsage(for: code)
        let modifierUsages = try modifiers.map { try modifierUsage(for: $0) }

        switch phase {
        case "down":
            try sendKeyDown(usage, modifiers: modifierUsages)
        case "up":
            try sendKeyUp(usage, modifiers: modifierUsages)
        case "press":
            try pressKey(usage, modifiers: modifierUsages)
        default:
            throw BridgeError(code: "invalid_params", message: "Unsupported key phase: \(phase)")
        }

        return ["udid": udid, "sent": true, "kind": "key", "code": code, "phase": phase]
    }

    func sendText(_ text: String) throws -> [String: Any] {
        let mappedText = try text.unicodeScalars.map { try textUsage(for: $0) }
        for mapped in mappedText {
            try pressKey(mapped.usage, modifiers: mapped.shift ? [HIDUsage(page: 7, usage: 0xE1)] : [])
        }
        return ["udid": udid, "sent": true, "kind": "text", "characters": mappedText.count]
    }

    func pressButton(_ button: String) throws -> [String: Any] {
        switch button {
        case "home":
            try pressLegacyButton(code: 0)
        case "lock", "power":
            try pressLegacyButton(code: 1)
        default:
            throw BridgeError(code: "unsupported_button", message: "Unsupported simulator hardware button: \(button)")
        }
        return ["udid": udid, "sent": true, "kind": "button", "button": button]
    }

    func tap(x: Double, y: Double, coordinateSpace: String, width: Double, height: Double, durationMs: Double) throws -> [String: Any] {
        let normal = normalizedPoint(x: x, y: y, coordinateSpace: coordinateSpace, width: width, height: height)
        try sendMouse(point: normal, eventType: Self.eventDown, direction: Self.directionDown, width: width, height: height)
        usleep(UInt32(max(20_000, min(500_000, durationMs * 1_000))))
        try sendMouse(point: normal, eventType: Self.eventUp, direction: Self.directionUp, width: width, height: height)
        return ["udid": udid, "sent": true, "kind": "tap", "x": normal.x, "y": normal.y]
    }

    func swipe(startX: Double, startY: Double, endX: Double, endY: Double, coordinateSpace: String, width: Double, height: Double, durationMs: Double) throws -> [String: Any] {
        let start = normalizedPoint(x: startX, y: startY, coordinateSpace: coordinateSpace, width: width, height: height)
        let end = normalizedPoint(x: endX, y: endY, coordinateSpace: coordinateSpace, width: width, height: height)
        let steps = 10
        let stepUs = UInt32(max(8_000, min(100_000, (durationMs * 1_000) / Double(steps + 2))))

        try sendMouse(point: start, eventType: Self.eventDown, direction: Self.directionDown, width: width, height: height)
        for index in 1...steps {
            let t = Double(index) / Double(steps)
            let point = CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)
            usleep(stepUs)
            try sendMouse(point: point, eventType: Self.eventDragged, direction: Self.directionMove, width: width, height: height)
        }
        try sendMouse(point: end, eventType: Self.eventUp, direction: Self.directionUp, width: width, height: height)
        return ["udid": udid, "sent": true, "kind": "swipe"]
    }

    func touch(phase: String, x: Double, y: Double, coordinateSpace: String, width: Double, height: Double) throws -> [String: Any] {
        let point = normalizedPoint(x: x, y: y, coordinateSpace: coordinateSpace, width: width, height: height)
        let event: UInt32
        let direction: UInt32
        switch phase {
        case "down":
            event = Self.eventDown
            direction = Self.directionDown
        case "move":
            event = Self.eventDragged
            direction = Self.directionMove
        case "up", "cancel":
            event = Self.eventUp
            direction = Self.directionUp
        default:
            throw BridgeError(code: "invalid_params", message: "Unsupported touch phase: \(phase)")
        }
        try sendMouse(point: point, eventType: event, direction: direction, width: width, height: height)
        return ["udid": udid, "sent": true, "kind": "touch", "phase": phase, "x": point.x, "y": point.y]
    }

    private func clientOrCreate() throws -> AnyObject {
        if let client {
            return client
        }

        let device = try runtime.device(udid: udid)
        guard let clientClass = NSClassFromString("_TtC12SimulatorKit24SimDeviceLegacyHIDClient")
            ?? NSClassFromString("SimulatorKit.SimDeviceLegacyHIDClient") else {
            throw BridgeError(code: "simulator_kit_class_missing", message: "SimulatorKit did not expose SimDeviceLegacyHIDClient.")
        }

        let allocSelector = NSSelectorFromString("alloc")
        guard let metaClass = object_getClass(clientClass),
              let allocImp = class_getMethodImplementation(metaClass, allocSelector) else {
            throw BridgeError(code: "simulator_kit_selector_missing", message: "SimDeviceLegacyHIDClient.alloc is unavailable.")
        }
        typealias AllocFn = @convention(c) (AnyClass, Selector) -> AnyObject?
        guard let allocated = unsafeBitCast(allocImp, to: AllocFn.self)(clientClass, allocSelector) else {
            throw BridgeError(code: "simulator_kit_client_failed", message: "Failed to allocate SimDeviceLegacyHIDClient.")
        }

        let initSelector = NSSelectorFromString("initWithDevice:error:")
        guard let initImp = class_getMethodImplementation(clientClass, initSelector) else {
            throw BridgeError(code: "simulator_kit_selector_missing", message: "SimDeviceLegacyHIDClient.initWithDevice:error: is unavailable.")
        }
        typealias InitFn = @convention(c) (AnyObject, Selector, AnyObject, AutoreleasingUnsafeMutablePointer<NSError?>) -> AnyObject?

        var error: NSError?
        guard let created = unsafeBitCast(initImp, to: InitFn.self)(allocated, initSelector, device, &error) else {
            throw BridgeError(code: "simulator_kit_client_failed", message: error?.localizedDescription ?? "Failed to create SimDeviceLegacyHIDClient.")
        }

        client = created
        return created
    }

    private func send(_ message: UnsafeMutableRawPointer) throws {
        let client = try clientOrCreate()
        let selector = NSSelectorFromString("sendWithMessage:freeWhenDone:completionQueue:completion:")
        guard let clientClass = object_getClass(client),
              let imp = class_getMethodImplementation(clientClass, selector) else {
            throw BridgeError(code: "simulator_kit_selector_missing", message: "SimDeviceLegacyHIDClient.sendWithMessage is unavailable.")
        }
        typealias SendFn = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer, ObjCBool, AnyObject?, AnyObject?) -> Void
        unsafeBitCast(imp, to: SendFn.self)(client, selector, message, ObjCBool(true), nil, nil)
    }

    private func sendKeyDown(_ usage: HIDUsage, modifiers: [HIDUsage]) throws {
        for modifier in modifiers {
            try sendHID(usage: modifier, operation: 1)
        }
        try sendHID(usage: usage, operation: 1)
    }

    private func sendKeyUp(_ usage: HIDUsage, modifiers: [HIDUsage]) throws {
        try sendHID(usage: usage, operation: 2)
        for modifier in modifiers.reversed() {
            try sendHID(usage: modifier, operation: 2)
        }
    }

    private func pressKey(_ usage: HIDUsage, modifiers: [HIDUsage]) throws {
        try sendKeyDown(usage, modifiers: modifiers)
        usleep(50_000)
        try sendKeyUp(usage, modifiers: modifiers)
    }

    private func sendHID(usage: HIDUsage, operation: UInt32) throws {
        let fn: HIDArbitraryFn = try runtime.symbol("IndigoHIDMessageForHIDArbitrary", as: HIDArbitraryFn.self)
        guard let message = fn(Self.digitizerTarget, usage.page, usage.usage, operation) else {
            throw BridgeError(code: "hid_message_failed", message: "SimulatorKit failed to build a HID message.")
        }
        try send(message)
    }

    private func pressLegacyButton(code: UInt32) throws {
        let fn: ButtonFn = try runtime.symbol("IndigoHIDMessageForButton", as: ButtonFn.self)
        guard let down = fn(code, 1, Self.buttonTarget) else {
            throw BridgeError(code: "hid_message_failed", message: "SimulatorKit failed to build a button-down HID message.")
        }
        try send(down)
        usleep(80_000)
        guard let up = fn(code, 2, Self.buttonTarget) else {
            throw BridgeError(code: "hid_message_failed", message: "SimulatorKit failed to build a button-up HID message.")
        }
        try send(up)
    }

    private func sendMouse(point: CGPoint, eventType: UInt32, direction: UInt32, width: Double, height: Double) throws {
        let fn: MouseFn = try runtime.symbol("IndigoHIDMessageForMouseNSEvent", as: MouseFn.self)
        var mutablePoint = point
        let message = withUnsafePointer(to: &mutablePoint) { pointer in
            fn(pointer, nil, Self.digitizerTarget, eventType, direction, 1.0, 1.0, width, height)
        }
        guard let message else {
            throw BridgeError(code: "hid_message_failed", message: "SimulatorKit failed to build a touch HID message.")
        }
        try send(message)
    }

    private func normalizedPoint(x: Double, y: Double, coordinateSpace: String, width: Double, height: Double) -> CGPoint {
        if coordinateSpace == "points" {
            return CGPoint(x: clamp(x / width), y: clamp(y / height))
        }
        return CGPoint(x: clamp(x), y: clamp(y))
    }

    private func clamp(_ value: Double) -> Double {
        min(1, max(0, value))
    }

    private func keyUsage(for code: String) throws -> HIDUsage {
        if code.hasPrefix("Key"), let scalar = code.unicodeScalars.last, scalar.value >= 65, scalar.value <= 90 {
            return HIDUsage(page: 7, usage: 0x04 + UInt32(scalar.value - 65))
        }
        if code.hasPrefix("Digit"), let digit = Int(code.dropFirst("Digit".count)) {
            return HIDUsage(page: 7, usage: digit == 0 ? 0x27 : UInt32(0x1D + digit))
        }

        let usages: [String: UInt32] = [
            "Enter": 0x28, "Escape": 0x29, "Backspace": 0x2A, "Tab": 0x2B, "Space": 0x2C,
            "Minus": 0x2D, "Equal": 0x2E, "BracketLeft": 0x2F, "BracketRight": 0x30,
            "Backslash": 0x31, "Semicolon": 0x33, "Quote": 0x34, "Backquote": 0x35,
            "Comma": 0x36, "Period": 0x37, "Slash": 0x38, "CapsLock": 0x39,
            "F1": 0x3A, "F2": 0x3B, "F3": 0x3C, "F4": 0x3D, "F5": 0x3E, "F6": 0x3F,
            "F7": 0x40, "F8": 0x41, "F9": 0x42, "F10": 0x43, "F11": 0x44, "F12": 0x45,
            "PrintScreen": 0x46, "ScrollLock": 0x47, "Pause": 0x48, "Insert": 0x49,
            "Home": 0x4A, "PageUp": 0x4B, "Delete": 0x4C, "End": 0x4D, "PageDown": 0x4E,
            "ArrowRight": 0x4F, "ArrowLeft": 0x50, "ArrowDown": 0x51, "ArrowUp": 0x52,
        ]
        if let usage = usages[code] {
            return HIDUsage(page: 7, usage: usage)
        }
        throw BridgeError(code: "unsupported_key", message: "Unsupported keyboard code: \(code)")
    }

    private func modifierUsage(for modifier: String) throws -> HIDUsage {
        switch modifier {
        case "control": return HIDUsage(page: 7, usage: 0xE0)
        case "shift": return HIDUsage(page: 7, usage: 0xE1)
        case "option": return HIDUsage(page: 7, usage: 0xE2)
        case "command": return HIDUsage(page: 7, usage: 0xE3)
        default:
            throw BridgeError(code: "unsupported_modifier", message: "Unsupported keyboard modifier: \(modifier)")
        }
    }

    private func textUsage(for scalar: UnicodeScalar) throws -> (usage: HIDUsage, shift: Bool) {
        let value = scalar.value
        if value >= 65 && value <= 90 {
            return (HIDUsage(page: 7, usage: 0x04 + UInt32(value - 65)), true)
        }
        if value >= 97 && value <= 122 {
            return (HIDUsage(page: 7, usage: 0x04 + UInt32(value - 97)), false)
        }
        if value >= 49 && value <= 57 {
            return (HIDUsage(page: 7, usage: 0x1E + UInt32(value - 49)), false)
        }
        if value == 48 {
            return (HIDUsage(page: 7, usage: 0x27), false)
        }

        let table: [UnicodeScalar: (String, Bool)] = [
            "\n": ("Enter", false), "\t": ("Tab", false), " ": ("Space", false),
            "-": ("Minus", false), "_": ("Minus", true), "=": ("Equal", false), "+": ("Equal", true),
            "[": ("BracketLeft", false), "{": ("BracketLeft", true), "]": ("BracketRight", false), "}": ("BracketRight", true),
            "\\": ("Backslash", false), "|": ("Backslash", true), ";": ("Semicolon", false), ":": ("Semicolon", true),
            "'": ("Quote", false), "\"": ("Quote", true), "`": ("Backquote", false), "~": ("Backquote", true),
            ",": ("Comma", false), "<": ("Comma", true), ".": ("Period", false), ">": ("Period", true),
            "/": ("Slash", false), "?": ("Slash", true), "!": ("Digit1", true), "@": ("Digit2", true),
            "#": ("Digit3", true), "$": ("Digit4", true), "%": ("Digit5", true), "^": ("Digit6", true),
            "&": ("Digit7", true), "*": ("Digit8", true), "(": ("Digit9", true), ")": ("Digit0", true),
        ]
        if let mapped = table[scalar] {
            return (try keyUsage(for: mapped.0), mapped.1)
        }

        throw BridgeError(code: "unsupported_text", message: "Direct HID text input only supports ASCII characters; paste support will handle broader Unicode later.")
    }
}
