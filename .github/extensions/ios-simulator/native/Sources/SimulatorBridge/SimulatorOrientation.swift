import Darwin.Mach
import Foundation
import ObjectiveC

enum DeviceOrientation: UInt32 {
    case portrait = 1
    case portraitUpsideDown = 2
    case landscapeRight = 3
    case landscapeLeft = 4

    init?(wireName: String) {
        switch wireName {
        case "portrait": self = .portrait
        case "portrait-upside-down": self = .portraitUpsideDown
        case "landscape-right": self = .landscapeRight
        case "landscape-left": self = .landscapeLeft
        default: return nil
        }
    }

    var wireName: String {
        switch self {
        case .portrait: "portrait"
        case .portraitUpsideDown: "portrait-upside-down"
        case .landscapeRight: "landscape-right"
        case .landscapeLeft: "landscape-left"
        }
    }
}

enum SimulatorOrientation {
    static func set(_ orientation: DeviceOrientation, udid: String) throws -> [String: Any] {
        let device = try SimulatorRuntime.shared.device(udid: udid)
        guard let port = lookupMachPort(on: device, named: "PurpleWorkspacePort"), port != 0 else {
            throw BridgeError(code: "orientation_port_unavailable", message: "Simulator did not expose PurpleWorkspacePort for \(udid).")
        }

        guard sendMachMessage(buildMachMessage(orientation: orientation, remotePort: port)) else {
            throw BridgeError(code: "orientation_send_failed", message: "Simulator rejected the orientation event.")
        }

        return ["udid": udid, "orientation": orientation.wireName]
    }

    private static func lookupMachPort(on device: NSObject, named name: String) -> UInt32? {
        let selector = NSSelectorFromString("lookup:error:")
        guard device.responds(to: selector) else {
            return nil
        }

        typealias LookupFn = @convention(c) (
            AnyObject,
            Selector,
            NSString,
            UnsafeMutablePointer<NSError?>?
        ) -> UInt32
        let fn = unsafeBitCast(device.method(for: selector), to: LookupFn.self)
        var error: NSError?
        let port = fn(device, selector, name as NSString, &error)
        return port == 0 ? nil : port
    }

    private static func buildMachMessage(orientation: DeviceOrientation, remotePort: UInt32) -> Data {
        var data = Data(repeating: 0, count: 112)
        write(0x13, at: 0x00, into: &data)
        write(108, at: 0x04, into: &data)
        write(remotePort, at: 0x08, into: &data)
        write(0x7B, at: 0x14, into: &data)
        write(50 | 0x20000, at: 0x18, into: &data)
        write(4, at: 0x48, into: &data)
        write(orientation.rawValue, at: 0x4C, into: &data)
        return data
    }

    private static func sendMachMessage(_ data: Data) -> Bool {
        var copy = data
        let result: kern_return_t = copy.withUnsafeMutableBytes { raw in
            guard let base = raw.baseAddress else {
                return KERN_FAILURE
            }
            return mach_msg_send(base.assumingMemoryBound(to: mach_msg_header_t.self))
        }
        return result == KERN_SUCCESS
    }

    private static func write<T: BinaryInteger>(_ value: T, at offset: Int, into data: inout Data) {
        let raw = UInt32(value)
        data[offset] = UInt8(raw & 0xFF)
        data[offset + 1] = UInt8((raw >> 8) & 0xFF)
        data[offset + 2] = UInt8((raw >> 16) & 0xFF)
        data[offset + 3] = UInt8((raw >> 24) & 0xFF)
    }
}
