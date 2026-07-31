import Foundation

struct Simctl {
    func listDevices() throws -> Any {
        let output = try Shell.capture("/usr/bin/xcrun", ["simctl", "list", "devices", "--json"], timeoutSeconds: 10)
        guard let data = output.data(using: .utf8) else {
            throw BridgeError(code: "simctl_encoding_failed", message: "simctl output was not valid UTF-8.")
        }
        return try JSONSerialization.jsonObject(with: data)
    }

    func boot(_ udid: String) throws -> [String: Any] {
        do {
            _ = try Shell.capture("/usr/bin/xcrun", ["simctl", "boot", udid])
        } catch let error as BridgeError where error.message.contains("current state: Booted") {
        }
        _ = try Shell.capture("/usr/bin/xcrun", ["simctl", "bootstatus", udid, "-b"], timeoutSeconds: 240)
        return ["udid": udid, "state": "Booted"]
    }

    func shutdown(_ udid: String) throws -> [String: Any] {
        do {
            _ = try Shell.capture("/usr/bin/xcrun", ["simctl", "shutdown", udid])
        } catch let error as BridgeError where error.message.contains("current state: Shutdown") {
        }
        return ["udid": udid, "state": "Shutdown"]
    }
}
