import Foundation
import CoreVideo
import VideoToolbox

final class H264StreamEncoder: @unchecked Sendable {
    enum EncodedKind {
        case description
        case keyframe
        case delta
    }

    private var session: VTCompressionSession?
    private var width: Int32 = 0
    private var height: Int32 = 0
    private var frameCount: Int64 = 0
    private var emittedDescription = false
    private let fps: Int32
    private let bitrate: Int
    private let onEncoded: @Sendable (EncodedKind, Data) -> Void

    init(fps: Int, bitrate: Int = 4_000_000, onEncoded: @escaping @Sendable (EncodedKind, Data) -> Void) {
        self.fps = Int32(max(1, fps))
        self.bitrate = bitrate
        self.onEncoded = onEncoded
    }

    deinit {
        if let session {
            VTCompressionSessionInvalidate(session)
        }
    }

    func encode(_ pixelBuffer: CVPixelBuffer, forceKeyframe: Bool) {
        let nextWidth = Int32(CVPixelBufferGetWidth(pixelBuffer))
        let nextHeight = Int32(CVPixelBufferGetHeight(pixelBuffer))
        if session == nil || nextWidth != width || nextHeight != height {
            width = nextWidth
            height = nextHeight
            rebuildSession()
        }
        guard let session else { return }

        frameCount += 1
        let frameProperties = forceKeyframe
            ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue!] as CFDictionary
            : nil
        VTCompressionSessionEncodeFrame(
            session,
            imageBuffer: pixelBuffer,
            presentationTimeStamp: CMTime(value: frameCount, timescale: fps),
            duration: CMTime(value: 1, timescale: fps),
            frameProperties: frameProperties,
            infoFlagsOut: nil
        ) { [weak self] status, _, sampleBuffer in
            guard let self, status == noErr, let sampleBuffer else { return }
            self.handle(sampleBuffer)
        }
    }

    private func rebuildSession() {
        if let session {
            VTCompressionSessionInvalidate(session)
            self.session = nil
        }

        let encoderSpec = [
            kVTVideoEncoderSpecification_EnableLowLatencyRateControl: kCFBooleanTrue!,
        ] as CFDictionary
        var created: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: width,
            height: height,
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: encoderSpec,
            imageBufferAttributes: nil,
            compressedDataAllocator: kCFAllocatorDefault,
            outputCallback: nil,
            refcon: nil,
            compressionSessionOut: &created
        )
        guard status == noErr, let created else { return }

        let properties: [(CFString, Any)] = [
            (kVTCompressionPropertyKey_RealTime, kCFBooleanTrue!),
            (kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_Baseline_AutoLevel),
            (kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse!),
            (kVTCompressionPropertyKey_AverageBitRate, NSNumber(value: bitrate)),
            (kVTCompressionPropertyKey_ExpectedFrameRate, NSNumber(value: fps)),
            (kVTCompressionPropertyKey_MaxKeyFrameInterval, NSNumber(value: Int(fps) * 2)),
            (kVTCompressionPropertyKey_MaxFrameDelayCount, NSNumber(value: 0)),
        ]
        for (key, value) in properties {
            VTSessionSetProperty(created, key: key, value: value as CFTypeRef)
        }
        VTCompressionSessionPrepareToEncodeFrames(created)

        session = created
        emittedDescription = false
    }

    private func handle(_ sampleBuffer: CMSampleBuffer) {
        let keyframe = isKeyframe(sampleBuffer)
        if keyframe, !emittedDescription, let format = CMSampleBufferGetFormatDescription(sampleBuffer),
           let description = avcCBlob(from: format) {
            emittedDescription = true
            onEncoded(.description, description)
        }

        guard let dataBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        var totalLength = 0
        var pointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(
            dataBuffer,
            atOffset: 0,
            lengthAtOffsetOut: nil,
            totalLengthOut: &totalLength,
            dataPointerOut: &pointer
        ) == noErr, let pointer else {
            return
        }
        onEncoded(keyframe ? .keyframe : .delta, Data(bytes: pointer, count: totalLength))
    }

    private func isKeyframe(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false),
              CFArrayGetCount(attachments) > 0,
              let attachment = CFArrayGetValueAtIndex(attachments, 0) else {
            return true
        }
        let dictionary = unsafeBitCast(attachment, to: CFDictionary.self)
        return !CFDictionaryContainsKey(dictionary, Unmanaged.passUnretained(kCMSampleAttachmentKey_NotSync).toOpaque())
    }

    private func avcCBlob(from format: CMFormatDescription) -> Data? {
        var spsCount = 0
        var spsPointer: UnsafePointer<UInt8>?
        var spsSize = 0
        var nalLength: Int32 = 0
        guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format,
            parameterSetIndex: 0,
            parameterSetPointerOut: &spsPointer,
            parameterSetSizeOut: &spsSize,
            parameterSetCountOut: &spsCount,
            nalUnitHeaderLengthOut: &nalLength
        ) == noErr, let spsPointer else {
            return nil
        }

        var ppsPointer: UnsafePointer<UInt8>?
        var ppsSize = 0
        guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format,
            parameterSetIndex: 1,
            parameterSetPointerOut: &ppsPointer,
            parameterSetSizeOut: &ppsSize,
            parameterSetCountOut: nil,
            nalUnitHeaderLengthOut: nil
        ) == noErr, let ppsPointer else {
            return nil
        }

        let sps = UnsafeBufferPointer(start: spsPointer, count: spsSize)
        let pps = UnsafeBufferPointer(start: ppsPointer, count: ppsSize)
        var out = Data()
        out.append(0x01)
        out.append(sps[1])
        out.append(sps[2])
        out.append(sps[3])
        out.append(0xFF)
        out.append(0xE1)
        out.append(UInt8((spsSize >> 8) & 0xFF))
        out.append(UInt8(spsSize & 0xFF))
        out.append(contentsOf: sps)
        out.append(0x01)
        out.append(UInt8((ppsSize >> 8) & 0xFF))
        out.append(UInt8(ppsSize & 0xFF))
        out.append(contentsOf: pps)
        return out
    }
}
