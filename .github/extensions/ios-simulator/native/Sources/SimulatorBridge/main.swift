import Darwin
import Foundation
import CoreGraphics

func writeResponse(id: String?, ok: Bool, payload: Any) {
    guard let id else {
        return
    }
    var object: [String: Any] = [
        "ok": ok,
        "id": id,
    ]
    if ok {
        object["result"] = payload
    } else {
        object["error"] = payload
    }

    let data = try! JSONSerialization.data(withJSONObject: object)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
}

func writeDiagnosticError(_ code: String, _ message: String) {
    FileHandle.standardError.write(Data("\(code): \(message)\n".utf8))
}

func streamArgument(_ name: String, default fallback: String? = nil) -> String? {
    let args = CommandLine.arguments
    for index in args.indices {
        if args[index] == name, args.indices.contains(index + 1) {
            return args[index + 1]
        }
        if args[index].hasPrefix("\(name)=") {
            return String(args[index].dropFirst(name.count + 1))
        }
    }
    return fallback
}

if CommandLine.arguments.dropFirst().first == "stream-mjpeg" || CommandLine.arguments.dropFirst().first == "stream-h264" {
    do {
        let mode = CommandLine.arguments.dropFirst().first ?? "stream-mjpeg"
        guard let udid = streamArgument("--udid"), !udid.isEmpty else {
            throw BridgeError(code: "invalid_params", message: "Missing required --udid for \(mode).")
        }
        let fps = Int(streamArgument("--fps", default: "30") ?? "30") ?? 30
        let quality = Double(streamArgument("--quality", default: "0.72") ?? "0.72") ?? 0.72
        let resolution = Int(streamArgument("--resolution", default: "100") ?? "100") ?? 100
        let streamer = SimulatorScreenStream(
            udid: udid,
            fps: fps,
            quality: CGFloat(quality),
            resolutionPercent: resolution
        )
        if mode == "stream-h264" {
            try streamer.startH264()
        } else {
            try streamer.startMJPEG()
        }
    } catch let error as BridgeError {
        FileHandle.standardError.write(Data("\(error.code): \(error.message)\n".utf8))
        exit(1)
    } catch {
        FileHandle.standardError.write(Data("internal_error: \(String(describing: error))\n".utf8))
        exit(1)
    }
}

let bridge = Bridge()
let decoder = JSONDecoder()

while let line = readLine() {
    guard let data = line.data(using: .utf8) else {
        writeResponse(id: nil, ok: false, payload: ["code": "invalid_utf8", "message": "Command line was not valid UTF-8."])
        continue
    }

    var requestId: String?
    do {
        let envelope = try decoder.decode(CommandEnvelope.self, from: data)
        requestId = envelope.id
        let result = try bridge.handle(envelope)
        writeResponse(id: envelope.id, ok: true, payload: result)
    } catch let error as BridgeError {
        if requestId == nil {
            writeDiagnosticError(error.code, error.message)
        } else {
            writeResponse(id: requestId, ok: false, payload: ["code": error.code, "message": error.message])
        }
    } catch {
        if requestId == nil {
            writeDiagnosticError("internal_error", String(describing: error))
        } else {
            writeResponse(id: requestId, ok: false, payload: ["code": "internal_error", "message": String(describing: error)])
        }
    }
}
