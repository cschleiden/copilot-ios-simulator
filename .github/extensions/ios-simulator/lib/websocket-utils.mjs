import { createHash } from "node:crypto";
import { AppError } from "./errors.mjs";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function websocketAcceptKey(key) {
    return createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
}

export function websocketCloseFrame(code = 1000) {
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    return Buffer.from([0x88, payload.length, ...payload]);
}

export function parseWebSocketFrames(buffer) {
    const messages = [];
    let offset = 0;
    while (buffer.length - offset >= 2) {
        const first = buffer[offset];
        const second = buffer[offset + 1];
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        let length = second & 0x7f;
        let headerLength = 2;
        if (length === 126) {
            if (buffer.length - offset < 4) break;
            length = buffer.readUInt16BE(offset + 2);
            headerLength = 4;
        } else if (length === 127) {
            throw new AppError("websocket_frame_too_large", "Large WebSocket frames are not supported.", 413);
        }
        const maskLength = masked ? 4 : 0;
        const frameLength = headerLength + maskLength + length;
        if (buffer.length - offset < frameLength) break;

        const payloadStart = offset + headerLength + maskLength;
        const payload = Buffer.from(buffer.subarray(payloadStart, payloadStart + length));
        if (masked) {
            const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
            for (let index = 0; index < payload.length; index += 1) {
                payload[index] ^= mask[index % 4];
            }
        }
        messages.push({ opcode, payload });
        offset += frameLength;
    }
    return { messages, remaining: buffer.subarray(offset) };
}
