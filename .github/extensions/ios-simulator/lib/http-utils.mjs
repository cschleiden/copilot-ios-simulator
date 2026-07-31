import { AppError } from "./errors.mjs";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_STREAM_BYTES = 2 * 1024 * 1024;

export function json(res, status, payload) {
    const body = JSON.stringify(payload);
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Length", Buffer.byteLength(body));
    res.end(body);
}

export function text(res, status, body) {
    res.statusCode = status;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(body);
}

function isLoopbackHost(value) {
    if (!value) {
        return false;
    }
    const host = value.split(":")[0]?.toLowerCase();
    return host === "127.0.0.1" || host === "localhost";
}

export function assertLoopbackRequest(req) {
    const host = req.headers.host;
    if (!isLoopbackHost(host)) {
        throw new AppError("forbidden_host", "Canvas requests must target a loopback host.", 403);
    }

    const origin = req.headers.origin;
    if (origin) {
        let parsed;
        try {
            parsed = new URL(origin);
        } catch {
            throw new AppError("forbidden_origin", "Invalid Origin header.", 403);
        }
        if (!isLoopbackHost(parsed.host)) {
            throw new AppError("forbidden_origin", "Canvas requests must originate from loopback.", 403);
        }
    }
}

export async function readJsonBody(req) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
            throw new AppError("payload_too_large", "Request payload exceeds the size limit.", 413);
        }
        chunks.push(chunk);
    }

    if (chunks.length === 0) {
        return {};
    }

    const contentType = req.headers["content-type"] ?? "";
    if (!String(contentType).includes("application/json")) {
        throw new AppError("invalid_content_type", "Expected application/json request body.", 415);
    }

    const merged = Buffer.concat(chunks).toString("utf8");
    try {
        return JSON.parse(merged);
    } catch {
        throw new AppError("invalid_json", "Malformed JSON payload.", 400);
    }
}

export async function readLineStream(req, onLine) {
    let total = 0;
    let buffer = "";
    for await (const chunk of req) {
        total += chunk.length;
        if (total > MAX_STREAM_BYTES) {
            throw new AppError("payload_too_large", "Streaming request payload exceeds the size limit.", 413);
        }
        buffer += chunk.toString("utf8");
        while (true) {
            const newline = buffer.indexOf("\n");
            if (newline === -1) {
                break;
            }
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line) {
                await onLine(line);
            }
        }
    }

    const finalLine = buffer.trim();
    if (finalLine) {
        await onLine(finalLine);
    }
}
