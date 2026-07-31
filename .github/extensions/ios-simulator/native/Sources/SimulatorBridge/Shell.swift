import Foundation

enum Shell {
    static func capture(_ executable: String, _ arguments: [String], timeoutSeconds: TimeInterval = 30) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments

        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr

        try process.run()
        let exited = DispatchSemaphore(value: 0)
        DispatchQueue.global(qos: .utility).async {
            process.waitUntilExit()
            exited.signal()
        }

        if exited.wait(timeout: .now() + timeoutSeconds) == .timedOut {
            process.terminate()
            if exited.wait(timeout: .now() + 2) == .timedOut {
                process.interrupt()
            }
            throw BridgeError(
                code: "process_timeout",
                message: "\(executable) \(arguments.joined(separator: " ")) timed out after \(Int(timeoutSeconds))s."
            )
        }

        let output = String(data: stdout.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let error = String(data: stderr.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        guard process.terminationStatus == 0 else {
            throw BridgeError(code: "process_failed", message: error.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? output : error)
        }
        return output
    }
}
