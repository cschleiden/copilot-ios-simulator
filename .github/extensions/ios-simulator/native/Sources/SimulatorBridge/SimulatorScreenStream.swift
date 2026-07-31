import Foundation
import CoreGraphics
import CoreImage
import CoreVideo
import ImageIO
import IOSurface
import ObjectiveC
import UniformTypeIdentifiers

final class SimulatorScreenStream: @unchecked Sendable {
    private let udid: String
    private let fps: Int
    private let quality: CGFloat
    private let resolutionScale: CGFloat
    private let runtime = SimulatorRuntime.shared
    private let queue = DispatchQueue(label: "canvas-ios.screen", qos: .userInteractive)
    private let outputLock = NSLock()
    private let ciContext = CIContext(options: [.priorityRequestLow: false])

    private var ioClient: NSObject?
    private var descriptors: [NSObject] = []
    private var callbackUUIDs: [ObjectIdentifier: NSUUID] = [:]
    private var lastEmit = Date.distantPast
    private var h264: H264StreamEncoder?
    private var pendingH264Keyframe = true
    private var pendingH264Seed = true

    init(udid: String, fps: Int, quality: CGFloat = 0.72, resolutionPercent: Int = 100) {
        self.udid = udid
        self.fps = min(60, max(1, fps))
        self.quality = min(1, max(0.1, quality))
        self.resolutionScale = CGFloat(min(100, max(1, resolutionPercent))) / 100
    }

    func startMJPEG() throws {
        try wireFramebuffer()
        captureLatest(force: true)
        dispatchMain()
    }

    func startH264() throws {
        h264 = H264StreamEncoder(fps: fps) { [weak self] kind, payload in
            self?.writeAVCC(kind: kind, payload: payload)
        }
        try wireFramebuffer()
        captureLatest(force: true)
        dispatchMain()
    }

    private func wireFramebuffer() throws {
        let device = try runtime.device(udid: udid)
        guard let io = device.perform(NSSelectorFromString("io"))?.takeUnretainedValue() as? NSObject else {
            throw BridgeError(code: "screen_io_unavailable", message: "SimulatorKit screen IO is unavailable for \(udid).")
        }
        ioClient = io
        io.perform(NSSelectorFromString("updateIOPorts"))

        guard let ports = io.value(forKey: "deviceIOPorts") as? [NSObject] else {
            throw BridgeError(code: "screen_framebuffer_unavailable", message: "SimulatorKit did not expose framebuffer ports.")
        }

        let portIdentifierSelector = NSSelectorFromString("portIdentifier")
        let descriptorSelector = NSSelectorFromString("descriptor")
        let framebufferSelector = NSSelectorFromString("framebufferSurface")

        descriptors = ports.compactMap { port in
            guard port.responds(to: portIdentifierSelector),
                  let identifier = port.perform(portIdentifierSelector)?.takeUnretainedValue(),
                  String(describing: identifier) == "com.apple.framebuffer.display",
                  port.responds(to: descriptorSelector),
                  let descriptor = port.perform(descriptorSelector)?.takeUnretainedValue() as? NSObject,
                  descriptor.responds(to: framebufferSelector) else {
                return nil
            }
            return descriptor
        }

        guard !descriptors.isEmpty else {
            throw BridgeError(code: "screen_framebuffer_unavailable", message: "No SimulatorKit framebuffer descriptors were found.")
        }

        for descriptor in descriptors {
            try registerCallbacks(on: descriptor)
        }
    }

    private func registerCallbacks(on descriptor: NSObject) throws {
        let selector = NSSelectorFromString(
            "registerScreenCallbacksWithUUID:callbackQueue:frameCallback:" +
            "surfacesChangedCallback:propertiesChangedCallback:"
        )
        guard descriptor.responds(to: selector),
              let imp = class_getMethodImplementation(type(of: descriptor), selector) else {
            throw BridgeError(code: "screen_callback_unavailable", message: "SimulatorKit framebuffer callbacks are unavailable.")
        }

        let uuid = NSUUID()
        callbackUUIDs[ObjectIdentifier(descriptor)] = uuid

        let frame: @convention(block) () -> Void = { [weak self] in
            guard let stream = self else { return }
            stream.queue.async { stream.captureLatest(force: false) }
        }
        let surfaces: @convention(block) () -> Void = { [weak self] in
            guard let stream = self else { return }
            stream.queue.async { stream.captureLatest(force: true) }
        }
        let properties: @convention(block) () -> Void = {}

        typealias RegisterFn = @convention(c) (
            AnyObject, Selector, AnyObject, AnyObject, AnyObject, AnyObject, AnyObject
        ) -> Void
        unsafeBitCast(imp, to: RegisterFn.self)(
            descriptor,
            selector,
            uuid,
            queue as AnyObject,
            frame as AnyObject,
            surfaces as AnyObject,
            properties as AnyObject
        )
    }

    private func captureLatest(force: Bool) {
        let minInterval = 1.0 / Double(fps)
        let now = Date()
        guard force || now.timeIntervalSince(lastEmit) >= minInterval else {
            return
        }

        let selector = NSSelectorFromString("framebufferSurface")
        var best: IOSurface?
        var bestArea = 0
        for descriptor in descriptors {
            guard let surfaceObject = descriptor.perform(selector)?.takeUnretainedValue() else {
                continue
            }
            let surface = unsafeDowncast(surfaceObject, to: IOSurface.self)
            let area = IOSurfaceGetWidth(surface) * IOSurfaceGetHeight(surface)
            if area > bestArea {
                best = surface
                bestArea = area
            }
        }

        guard let best else { return }
        lastEmit = now
        if let h264 {
            if pendingH264Seed, let jpeg = encodeJPEG(surface: best) {
                pendingH264Seed = false
                writeAVCC(tag: 0x04, payload: jpeg)
            }
            guard let pixelBuffer = outputPixelBuffer(surface: best) else { return }
            let forceKeyframe = pendingH264Keyframe || force
            pendingH264Keyframe = false
            h264.encode(pixelBuffer, forceKeyframe: forceKeyframe)
        } else if let jpeg = encodeJPEG(surface: best) {
            writeFrame(jpeg)
        }
    }

    private func encodeJPEG(surface: IOSurface) -> Data? {
        guard let pixelBuffer = outputPixelBuffer(surface: surface) else { return nil }
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        guard let cgImage = ciContext.createCGImage(image, from: image.extent) else {
            return nil
        }

        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data,
            UTType.jpeg.identifier as CFString,
            1,
            nil
        ) else {
            return nil
        }
        CGImageDestinationAddImage(
            destination,
            cgImage,
            [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary
        )
        guard CGImageDestinationFinalize(destination) else {
            return nil
        }
        return data as Data
    }

    private func outputPixelBuffer(surface: IOSurface) -> CVPixelBuffer? {
        guard let source = pixelBuffer(surface: surface) else {
            return nil
        }
        if resolutionScale >= 0.999 {
            return source
        }

        let width = max(2, (Int(CGFloat(CVPixelBufferGetWidth(source)) * resolutionScale) / 2) * 2)
        let height = max(2, (Int(CGFloat(CVPixelBufferGetHeight(source)) * resolutionScale) / 2) * 2)
        var copied: CVPixelBuffer?
        let copyStatus = CVPixelBufferCreate(
            kCFAllocatorDefault,
            width,
            height,
            kCVPixelFormatType_32BGRA,
            [
                kCVPixelBufferCGImageCompatibilityKey: true,
                kCVPixelBufferCGBitmapContextCompatibilityKey: true,
                kCVPixelBufferIOSurfacePropertiesKey: [:],
            ] as CFDictionary,
            &copied
        )
        guard copyStatus == kCVReturnSuccess, let copied else {
            return nil
        }
        let image = CIImage(cvPixelBuffer: source).transformed(
            by: CGAffineTransform(scaleX: resolutionScale, y: resolutionScale)
        )
        ciContext.render(image, to: copied)
        return copied
    }

    private func pixelBuffer(surface: IOSurface) -> CVPixelBuffer? {
        var unmanagedBuffer: Unmanaged<CVPixelBuffer>?
        let status = CVPixelBufferCreateWithIOSurface(
            kCFAllocatorDefault,
            surface,
            [kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA] as CFDictionary,
            &unmanagedBuffer
        )
        guard status == kCVReturnSuccess, let pixelBuffer = unmanagedBuffer?.takeRetainedValue() else {
            return nil
        }
        return pixelBuffer
    }

    private func writeFrame(_ jpeg: Data) {
        var frame = Data()
        frame.append(Data("--frame\r\nContent-Type: image/jpeg\r\nContent-Length: \(jpeg.count)\r\n\r\n".utf8))
        frame.append(jpeg)
        frame.append(Data("\r\n".utf8))
        write(frame)
    }

    private func writeAVCC(kind: H264StreamEncoder.EncodedKind, payload: Data) {
        switch kind {
        case .description: writeAVCC(tag: 0x01, payload: payload)
        case .keyframe: writeAVCC(tag: 0x02, payload: payload)
        case .delta: writeAVCC(tag: 0x03, payload: payload)
        }
    }

    private func writeAVCC(tag: UInt8, payload: Data) {
        let length = UInt32(payload.count + 1)
        var frame = Data(capacity: payload.count + 5)
        frame.append(UInt8((length >> 24) & 0xFF))
        frame.append(UInt8((length >> 16) & 0xFF))
        frame.append(UInt8((length >> 8) & 0xFF))
        frame.append(UInt8(length & 0xFF))
        frame.append(tag)
        frame.append(payload)
        write(frame)
    }

    private func write(_ data: Data) {
        outputLock.lock()
        defer { outputLock.unlock() }
        FileHandle.standardOutput.write(data)
    }
}
