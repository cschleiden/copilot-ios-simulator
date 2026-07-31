function avcCodecString(description) {
    if (description.length < 4) {
        return "avc1.64001f";
    }
    return `avc1.${[description[1], description[2], description[3]]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("")}`;
}

export function createH264StreamController({ onFrame, onError }) {
    let abortController = null;
    let decoder = null;
    let timestamp = 0;
    let failed = false;

    function stop() {
        abortController?.abort();
        abortController = null;
        if (decoder) {
            try {
                decoder.close();
            } catch {
            }
        }
        decoder = null;
    }

    function fail(error) {
        if (failed) {
            return;
        }
        failed = true;
        stop();
        onError(error);
    }

    function configureDecoder(description) {
        if (!("VideoDecoder" in window)) {
            throw new Error("This canvas runtime does not expose WebCodecs VideoDecoder.");
        }
        if (decoder) {
            decoder.close();
        }
        timestamp = 0;
        decoder = new VideoDecoder({
            output: (frame) => {
                try {
                    onFrame(frame);
                } catch (error) {
                    fail(error);
                } finally {
                    frame.close();
                }
            },
            error: fail,
        });
        decoder.configure({
            codec: avcCodecString(description),
            description,
            optimizeForLatency: true,
        });
    }

    async function drawSeed(payload) {
        const bitmap = await createImageBitmap(new Blob([payload], { type: "image/jpeg" }));
        try {
            onFrame(bitmap);
        } finally {
            bitmap.close();
        }
    }

    async function start({ url, fps }) {
        stop();
        failed = false;
        abortController = new AbortController();
        const signal = abortController.signal;

        try {
            const response = await fetch(url, { signal });
            if (!response.ok) {
                const payload = await response.json().catch(() => ({}));
                throw new Error(payload?.error?.message ?? `H.264 stream failed (${response.status})`);
            }
            const reader = response.body.getReader();
            let buffer = new Uint8Array(0);
            while (!signal.aborted) {
                const { value, done } = await reader.read();
                if (done) {
                    break;
                }
                const next = new Uint8Array(buffer.length + value.length);
                next.set(buffer);
                next.set(value, buffer.length);
                buffer = next;

                let offset = 0;
                while (buffer.length - offset >= 5) {
                    const length =
                        ((buffer[offset] << 24) |
                            (buffer[offset + 1] << 16) |
                            (buffer[offset + 2] << 8) |
                            buffer[offset + 3]) >>>
                        0;
                    if (buffer.length - offset < 4 + length) {
                        break;
                    }
                    const tag = buffer[offset + 4];
                    const payload = buffer.subarray(offset + 5, offset + 4 + length);
                    offset += 4 + length;
                    if (tag === 0x01) {
                        configureDecoder(payload);
                    } else if (tag === 0x02 || tag === 0x03) {
                        if (!decoder) {
                            continue;
                        }
                        timestamp += Math.round(1_000_000 / fps);
                        decoder.decode(
                            new EncodedVideoChunk({
                                type: tag === 0x02 ? "key" : "delta",
                                timestamp,
                                data: payload,
                            }),
                        );
                    } else if (tag === 0x04) {
                        await drawSeed(payload);
                    }
                }
                if (offset > 0) {
                    buffer = buffer.subarray(offset);
                }
            }
        } catch (error) {
            if (!signal.aborted) {
                fail(error);
            }
        }
    }

    return { start, stop };
}
