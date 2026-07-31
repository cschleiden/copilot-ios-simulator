import Darwin
import Foundation
import ObjectiveC

struct XcodeProbe {
    let developerDir: String
    let coreSimulatorPath: String
    let simulatorKitPath: String

    static func resolve() throws -> XcodeProbe {
        let developerDir = try Shell.capture("/usr/bin/xcode-select", ["-p"]).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !developerDir.isEmpty else {
            throw BridgeError(code: "xcode_not_selected", message: "xcode-select did not return a developer directory.")
        }

        let coreSimulatorCandidates = [
            developerDir + "/Library/PrivateFrameworks/CoreSimulator.framework/CoreSimulator",
            "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator",
        ]
        let simulatorKitCandidates = [
            developerDir + "/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit",
        ]
        let fileManager = FileManager.default

        guard let coreSimulator = coreSimulatorCandidates.first(where: { fileManager.fileExists(atPath: $0) }) else {
            throw BridgeError(code: "core_simulator_missing", message: "CoreSimulator.framework was not found under the selected Xcode.")
        }
        guard let simulatorKit = simulatorKitCandidates.first(where: { fileManager.fileExists(atPath: $0) }) else {
            throw BridgeError(code: "simulator_kit_missing", message: "SimulatorKit.framework was not found under the selected Xcode.")
        }

        return XcodeProbe(
            developerDir: developerDir,
            coreSimulatorPath: coreSimulator,
            simulatorKitPath: simulatorKit
        )
    }

    func validateLoadable() throws {
        let coreHandle = dlopen(coreSimulatorPath, RTLD_NOW | RTLD_LOCAL)
        guard coreHandle != nil else {
            throw BridgeError(code: "core_simulator_load_failed", message: String(cString: dlerror()))
        }
        dlclose(coreHandle)

        let simulatorKitHandle = dlopen(simulatorKitPath, RTLD_NOW | RTLD_LOCAL)
        guard simulatorKitHandle != nil else {
            throw BridgeError(code: "simulator_kit_load_failed", message: String(cString: dlerror()))
        }
        defer { dlclose(simulatorKitHandle) }

        let requiredSymbols = [
            "IndigoHIDMessageForMouseNSEvent",
            "IndigoHIDMessageForHIDArbitrary",
            "IndigoHIDMessageForButton",
        ]
        for symbol in requiredSymbols where dlsym(simulatorKitHandle, symbol) == nil {
            throw BridgeError(code: "simulator_kit_symbol_missing", message: "SimulatorKit did not expose \(symbol).")
        }
    }

    func json() -> [String: Any] {
        [
            "developerDir": developerDir,
            "coreSimulatorPath": coreSimulatorPath,
            "simulatorKitPath": simulatorKitPath,
        ]
    }
}

final class SimulatorRuntime: @unchecked Sendable {
    static let shared = SimulatorRuntime()

    private var probe: XcodeProbe?
    private var coreHandle: UnsafeMutableRawPointer?
    private var simulatorKitHandle: UnsafeMutableRawPointer?

    func load() throws -> XcodeProbe {
        if let probe {
            return probe
        }

        let resolved = try XcodeProbe.resolve()
        coreHandle = try openFramework(path: resolved.coreSimulatorPath, code: "core_simulator_load_failed")
        simulatorKitHandle = try openFramework(path: resolved.simulatorKitPath, code: "simulator_kit_load_failed")
        probe = resolved
        return resolved
    }

    func symbol<T>(_ name: String, as type: T.Type) throws -> T {
        _ = try load()
        guard let simulatorKitHandle, let symbol = dlsym(simulatorKitHandle, name) else {
            throw BridgeError(code: "simulator_kit_symbol_missing", message: "SimulatorKit did not expose \(name).")
        }
        return unsafeBitCast(symbol, to: type)
    }

    func device(udid: String) throws -> NSObject {
        let probe = try load()
        guard let serviceClass = NSClassFromString("SimServiceContext") as? NSObject.Type else {
            throw BridgeError(code: "core_simulator_class_missing", message: "CoreSimulator did not expose SimServiceContext.")
        }

        let serviceSelector = NSSelectorFromString("serviceContextForDeveloperDir:error:")
        guard let serviceMetaClass = object_getClass(serviceClass),
              let serviceImp = class_getMethodImplementation(serviceMetaClass, serviceSelector) else {
            throw BridgeError(code: "core_simulator_selector_missing", message: "SimServiceContext.serviceContextForDeveloperDir:error: is unavailable.")
        }
        typealias ServiceContextFn = @convention(c) (AnyClass, Selector, NSString, AutoreleasingUnsafeMutablePointer<NSError?>) -> AnyObject?

        var serviceError: NSError?
        guard let serviceContext = unsafeBitCast(serviceImp, to: ServiceContextFn.self)(
            serviceClass,
            serviceSelector,
            probe.developerDir as NSString,
            &serviceError
        ) else {
            throw BridgeError(code: "core_simulator_context_failed", message: serviceError?.localizedDescription ?? "CoreSimulator failed to create a service context.")
        }

        let deviceSetSelector = NSSelectorFromString("defaultDeviceSetWithError:")
        guard let deviceSetImp = class_getMethodImplementation(object_getClass(serviceContext), deviceSetSelector) else {
            throw BridgeError(code: "core_simulator_selector_missing", message: "SimServiceContext.defaultDeviceSetWithError: is unavailable.")
        }
        typealias DefaultDeviceSetFn = @convention(c) (AnyObject, Selector, AutoreleasingUnsafeMutablePointer<NSError?>) -> AnyObject?

        var deviceSetError: NSError?
        guard let deviceSet = unsafeBitCast(deviceSetImp, to: DefaultDeviceSetFn.self)(
            serviceContext,
            deviceSetSelector,
            &deviceSetError
        ) else {
            throw BridgeError(code: "core_simulator_device_set_failed", message: deviceSetError?.localizedDescription ?? "CoreSimulator failed to load the default device set.")
        }

        let devicesSelector = NSSelectorFromString("devices")
        guard deviceSet.responds(to: devicesSelector),
              let devicesObject = deviceSet.perform(devicesSelector)?.takeUnretainedValue() else {
            throw BridgeError(code: "core_simulator_devices_failed", message: "CoreSimulator device set did not return a device list.")
        }

        let devices: [Any]
        if let array = devicesObject as? NSArray {
            devices = array.map { $0 }
        } else if let set = devicesObject as? NSSet {
            devices = set.allObjects
        } else {
            throw BridgeError(code: "core_simulator_devices_failed", message: "CoreSimulator returned an unsupported device list type: \(type(of: devicesObject))")
        }

        for case let device as NSObject in devices {
            if deviceUdid(device) == udid {
                return device
            }
        }

        throw BridgeError(code: "unknown_device", message: "Simulator device not found: \(udid)")
    }

    private func openFramework(path: String, code: String) throws -> UnsafeMutableRawPointer {
        guard let handle = dlopen(path, RTLD_NOW | RTLD_GLOBAL) else {
            throw BridgeError(code: code, message: String(cString: dlerror()))
        }
        return handle
    }

    private func deviceUdid(_ device: NSObject) -> String? {
        let selector = NSSelectorFromString("UDID")
        guard device.responds(to: selector),
              let value = device.perform(selector)?.takeUnretainedValue() else {
            return nil
        }
        if let uuid = value as? UUID {
            return uuid.uuidString
        }
        if let uuid = value as? NSUUID {
            return uuid.uuidString
        }
        return String(describing: value)
    }
}
