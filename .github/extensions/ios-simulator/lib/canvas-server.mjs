import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { AppError, asAppError } from "./errors.mjs";
import {
    assertLoopbackRequest,
    json,
    readJsonBody,
    text,
} from "./http-utils.mjs";
import { loadWebAssets, serveWebAsset } from "./web-assets.mjs";
import {
    parseWebSocketFrames,
    websocketAcceptKey,
    websocketCloseFrame,
} from "./websocket-utils.mjs";

function formatPublicState(state) {
    if (!state) {
        return null;
    }

    const lease = state.lease?.active
        ? {
              ...state.lease,
              expiresInMs: Math.max(0, new Date(state.lease.expiresAt).getTime() - Date.now()),
          }
        : { active: false };

    return {
        ...state,
        lease,
    };
}

function unassignedState() {
    return {
        udid: null,
        name: "iOS Simulator",
        runtime: null,
        state: "Unassigned",
        isAvailable: true,
        deviceTypeIdentifier: null,
        deviceFamily: "phone",
        screen: { width: 1179, height: 2556, scale: 3 },
        orientation: "portrait",
        stream: { codec: "h264", fps: 60, resolution: 100, h264Available: true },
        keyboard: { mode: "hardware" },
        lease: { active: false },
    };
}

function enforceNoAgentLease(state) {
    if (state?.lease?.active || state?.controlPending) {
        throw new AppError(
            "lease_active",
            "Agent control is active. Use 'Take back control' to continue with manual interaction.",
            423,
        );
    }
}

function streamFpsFrom(value, fallback = 30) {
    const parsed = Number(value ?? fallback);
    return parsed === 60 ? 60 : 30;
}

function streamResolutionFrom(value, fallback = 100) {
    const parsed = Number(value ?? fallback);
    return parsed === 25 || parsed === 50 ? parsed : 100;
}

const EXPECTED_SOCKET_ERROR_CODES = new Set(["ECONNRESET", "EPIPE", "ERR_STREAM_PREMATURE_CLOSE"]);

function handleConnectionError(error, context) {
    if (EXPECTED_SOCKET_ERROR_CODES.has(error?.code)) {
        return;
    }
    console.warn(`[ios-simulator] ${context}: ${error?.message ?? String(error)}`);
}

function safeWrite(stream, chunk) {
    if (stream.destroyed || stream.writableEnded) {
        return false;
    }
    stream.write(chunk);
    return true;
}

export async function createCanvasServer({
    manager,
    instanceId,
    udid,
    webRoot,
    openDeviceCanvas,
    switchDeviceCanvas,
    bootAfterOpen = false,
}) {
    const webAssets = await loadWebAssets(webRoot);
    const token = randomBytes(18).toString("hex");
    const basePath = `/${token}`;
    const sseClients = new Set();
    const streamChildren = new Set();
    const touchConnections = new Set();
    let activeStreamChild = null;
    let streamGeneration = 0;
    let unsub = null;
    let unregisterManualInputStop = null;
    let bootAfterOpenStarted = false;
    let fallbackTouchEvent = null;
    let acceptingManualInput = true;
    const manualOperations = new Set();

    function writeStateEvent() {
        const state = udid ? formatPublicState(manager.snapshot(udid)) : unassignedState();
        const payload = `data: ${JSON.stringify(state)}\n\n`;
        for (const client of sseClients) {
            safeWrite(client, payload);
        }
    }

    function subscribeToDevice() {
        if (unsub) {
            unsub();
            unsub = null;
        }
        if (unregisterManualInputStop) {
            unregisterManualInputStop();
            unregisterManualInputStop = null;
        }
        if (!udid) {
            return;
        }
        unsub = manager.subscribe(udid, () => {
            const state = manager.snapshot(udid);
            if (!state.lease?.active && !state.controlPending) {
                acceptingManualInput = true;
            }
            writeStateEvent();
        });
        unregisterManualInputStop = manager.registerManualInputStop(udid, stopManualInput);
    }

    subscribeToDevice();

    async function cancelTouchEvent(event) {
        if (!event || event.phase === "up" || event.phase === "cancel") {
            return;
        }
        await manager.notifyTouch({
            udid: event.udid,
            phase: "cancel",
            x: event.x,
            y: event.y,
            coordinateSpace: "normalized",
        });
    }

    function closeTouchConnection(connection) {
        if (connection.closePromise) {
            return connection.closePromise;
        }
        connection.blocked = true;
        connection.closePromise = connection.queue
            .catch(() => {})
            .then(() => cancelTouchEvent(connection.lastEvent))
            .catch((error) => handleConnectionError(error, "touch cancellation failed"))
            .finally(() => {
                connection.socket.end();
            });
        return connection.closePromise;
    }

    function stopManualTouches() {
        const pending = [];
        for (const connection of touchConnections) {
            pending.push(closeTouchConnection(connection));
        }
        touchConnections.clear();
        return Promise.allSettled(pending).then(async () => {
            if (!fallbackTouchEvent) {
                return;
            }
            const event = fallbackTouchEvent;
            fallbackTouchEvent = null;
            await cancelTouchEvent(event).catch((error) =>
                handleConnectionError(error, "fallback touch cancellation failed"),
            );
        });
    }

    async function runManualOperation(operation) {
        if (!acceptingManualInput) {
            throw new AppError("manual_input_stopped", "Manual simulator input is no longer active.", 409);
        }
        const pending = Promise.resolve().then(operation);
        manualOperations.add(pending);
        try {
            return await pending;
        } finally {
            manualOperations.delete(pending);
        }
    }

    async function stopManualInput() {
        acceptingManualInput = false;
        await Promise.allSettled(Array.from(manualOperations));
        await stopManualTouches();
    }

    function stopActiveConnections({ blockManualInput = false } = {}) {
        if (blockManualInput) {
            acceptingManualInput = false;
        }
        streamGeneration += 1;
        for (const child of streamChildren) {
            if (!child.killed) {
                child.kill("SIGTERM");
            }
        }
        streamChildren.clear();
        activeStreamChild = null;
        return blockManualInput ? stopManualInput() : stopManualTouches();
    }

    function startBootAfterOpen() {
        if (!udid || !bootAfterOpen || bootAfterOpenStarted) {
            return;
        }
        bootAfterOpenStarted = true;
        queueMicrotask(() => {
            void manager.ensureBooted(udid).catch((error) => {
                handleConnectionError(error, "deferred simulator boot failed");
                try {
                    writeStateEvent();
                } catch (writeError) {
                    handleConnectionError(writeError, "deferred simulator boot state update failed");
                }
            });
        });
    }

    const server = createServer(async (req, res) => {
        try {
            const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
            const { pathname } = requestUrl;
            if (!(pathname === basePath || pathname.startsWith(`${basePath}/`))) {
                text(res, 404, "Not found");
                return;
            }

            const route = pathname.slice(basePath.length) || "/";

            if (req.method === "GET" && serveWebAsset(webAssets, route, res)) {
                if (route === "/" || route === "/index.html") {
                    startBootAfterOpen();
                }
                return;
            }

            if (req.method === "GET" && route === "/api/state") {
                const state = udid ? formatPublicState(await manager.getDeviceState(udid)) : unassignedState();
                json(res, 200, state);
                return;
            }

            if (req.method === "GET" && route === "/api/devices") {
                const devices = await manager.listDevicePicker(udid);
                json(res, 200, devices);
                return;
            }

            if (req.method === "GET" && route === "/api/events") {
                res.statusCode = 200;
                res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
                res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
                res.setHeader("Connection", "keep-alive");
                res.setHeader("X-Accel-Buffering", "no");
                sseClients.add(res);
                res.on("error", (error) => handleConnectionError(error, "SSE response error"));
                req.on("error", (error) => handleConnectionError(error, "SSE request error"));
                res.write("\n");
                writeStateEvent();
                const heartbeat = setInterval(() => {
                    if (!safeWrite(res, ": ping\n\n")) {
                        clearInterval(heartbeat);
                        sseClients.delete(res);
                    }
                }, 15_000);
                const cleanup = () => {
                    clearInterval(heartbeat);
                    sseClients.delete(res);
                };
                req.on("close", cleanup);
                res.on("close", cleanup);
                return;
            }

            if (req.method === "GET" && route === "/api/frame.png") {
                const png = await manager.getFramePng(udid);
                res.statusCode = 200;
                res.setHeader("Content-Type", "image/png");
                res.setHeader("Cache-Control", "no-store");
                res.end(png);
                return;
            }

            if (req.method === "GET" && (route === "/api/stream.mjpeg" || route === "/api/stream.h264")) {
                const fps = streamFpsFrom(requestUrl.searchParams.get("fps"));
                const resolution = streamResolutionFrom(requestUrl.searchParams.get("resolution"));
                const generation = ++streamGeneration;
                for (const existing of streamChildren) {
                    if (!existing.killed) {
                        existing.kill("SIGTERM");
                    }
                }
                const isH264 = route === "/api/stream.h264";
                const child = isH264
                    ? await manager.createH264Stream({ udid, fps, resolution })
                    : await manager.createMjpegStream({ udid, fps, resolution });
                if (generation !== streamGeneration) {
                    child.kill("SIGTERM");
                    res.statusCode = 409;
                    res.end();
                    return;
                }
                activeStreamChild = child;
                streamChildren.add(child);
                res.statusCode = 200;
                res.setHeader(
                    "Content-Type",
                    isH264 ? "application/vnd.copilot-ios-simulator.avcc" : "multipart/x-mixed-replace; boundary=frame",
                );
                res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
                res.setHeader("Connection", "close");

                res.on("error", (error) => handleConnectionError(error, "stream response error"));
                req.on("error", (error) => handleConnectionError(error, "stream request error"));
                child.stdout.on("error", (error) => handleConnectionError(error, "stream stdout error"));
                child.stdout.pipe(res);
                child.on("error", (error) => {
                    if (!res.headersSent) {
                        json(res, 502, {
                            error: { code: "stream_spawn_failed", message: error.message },
                        });
                    } else {
                        res.destroy(error);
                    }
                });
                child.on("exit", (code, signal) => {
                    streamChildren.delete(child);
                    if (activeStreamChild === child) {
                        activeStreamChild = null;
                    }
                    if (!res.destroyed && code !== 0 && signal == null) {
                        res.destroy(new Error(child.stderrText?.() || `Simulator stream exited with code ${code}`));
                    } else if (!res.destroyed) {
                        res.end();
                    }
                });
                req.on("close", () => {
                    if (!child.killed) {
                        child.kill("SIGTERM");
                    }
                });
                return;
            }

            if (req.method !== "POST" || !route.startsWith("/api/")) {
                text(res, 404, "Not found");
                return;
            }

            assertLoopbackRequest(req);

            const body = await readJsonBody(req);

            if (route === "/api/device/switch") {
                if (!switchDeviceCanvas) {
                    throw new AppError("device_switch_unavailable", "Device switching is not available in this session.", 501);
                }
                const targetUdid = body?.udid;
                const result = await switchDeviceCanvas({
                    instanceId,
                    fromUdid: udid,
                    toUdid: targetUdid,
                });
                json(res, 200, result);
                return;
            }

            if (route === "/api/device/open") {
                if (!openDeviceCanvas) {
                    throw new AppError("device_open_unavailable", "Opening a new simulator tab is not available in this session.", 501);
                }
                const targetUdid = body?.udid;
                const result = await openDeviceCanvas({ udid: targetUdid });
                json(res, 200, result);
                return;
            }

            if (route === "/api/control/revoke") {
                const state = await manager.revokeLease(udid, instanceId);
                json(res, 200, formatPublicState(state));
                return;
            }

            const state = manager.getCachedDeviceState(udid);
            enforceNoAgentLease(state);

            if (route === "/api/toolbar/boot") {
                const next = await runManualOperation(() => manager.bootDevice(udid));
                json(res, 200, formatPublicState(next));
                return;
            }

            if (route === "/api/toolbar/shutdown") {
                const next = await runManualOperation(() => manager.shutdownDevice(udid));
                json(res, 200, formatPublicState(next));
                return;
            }

            if (route === "/api/toolbar/restart") {
                const next = await runManualOperation(() => manager.restartDevice(udid));
                json(res, 200, formatPublicState(next));
                return;
            }

            if (route === "/api/stream/preferences") {
                const next = await runManualOperation(() =>
                    manager.setStreamPreferences(udid, {
                        codec: body?.codec,
                        fps: body?.fps,
                        resolution: body?.resolution,
                    }),
                );
                json(res, 200, formatPublicState(next));
                return;
            }

            if (route === "/api/keyboard/mode") {
                const next = await runManualOperation(() => manager.setKeyboardMode(udid, body?.mode));
                json(res, 200, formatPublicState(next));
                return;
            }

            if (route === "/api/toolbar/home") {
                await runManualOperation(() => manager.goHome({ udid }));
                json(res, 200, formatPublicState(manager.snapshot(udid)));
                return;
            }

            if (route === "/api/toolbar/rotate") {
                const direction = body?.direction;
                const result = await runManualOperation(() => manager.rotateDevice({ udid, direction }));
                json(res, 200, result);
                return;
            }

            if (route === "/api/input/tap") {
                const result = await runManualOperation(() => manager.tap({ udid, ...body }));
                json(res, 200, result);
                return;
            }

            if (route === "/api/input/swipe") {
                const result = await runManualOperation(() => manager.swipe({ udid, ...body }));
                json(res, 200, result);
                return;
            }

            if (route === "/api/input/touch") {
                const touchUdid = udid;
                const result = await runManualOperation(async () => {
                    const result = await manager.touch({ udid: touchUdid, ...body });
                    fallbackTouchEvent =
                        body?.phase === "up" || body?.phase === "cancel"
                            ? null
                            : {
                                  udid: touchUdid,
                                  phase: body?.phase,
                                  x: body?.x,
                                  y: body?.y,
                              };
                    if (
                        !acceptingManualInput ||
                        touchUdid !== udid
                    ) {
                        const event = fallbackTouchEvent;
                        fallbackTouchEvent = null;
                        await cancelTouchEvent(event);
                    } else {
                        const currentState = manager.getCachedDeviceState(touchUdid);
                        if (currentState.lease?.active || currentState.controlPending) {
                            const event = fallbackTouchEvent;
                            fallbackTouchEvent = null;
                            await cancelTouchEvent(event);
                        }
                    }
                    return result;
                });
                json(res, 200, result);
                return;
            }

            if (route === "/api/input/key") {
                const result = await runManualOperation(() => manager.sendKey({ udid, ...body }));
                json(res, 200, result);
                return;
            }

            if (route === "/api/input/text") {
                const result = await runManualOperation(() => manager.sendText({ udid, ...body }));
                json(res, 200, result);
                return;
            }

            text(res, 404, "Not found");
        } catch (error) {
            const appError = asAppError(error);
            json(res, appError.status ?? 500, {
                error: {
                    code: appError.code,
                    message: appError.message,
                    details: appError.details,
                },
            });
        }
    });

    server.on("connection", (socket) => {
        socket.on("error", (error) => handleConnectionError(error, "client socket error"));
    });

    server.on("clientError", (error, socket) => {
        handleConnectionError(error, "client protocol error");
        socket.destroy();
    });

    server.on("upgrade", (req, socket) => {
        socket.on("error", (error) => handleConnectionError(error, "touch websocket error"));
        void (async () => {
            try {
                const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
                const { pathname } = requestUrl;
                const route = pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : "";
                if (route !== "/api/input/touch-ws") {
                    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
                    socket.destroy();
                    return;
                }
                assertLoopbackRequest(req);
                if (!acceptingManualInput) {
                    throw new AppError("manual_input_stopped", "Manual simulator input is no longer active.", 409);
                }
                const state = manager.getCachedDeviceState(udid);
                enforceNoAgentLease(state);
                await manager.prepareTouchStream(udid);

                const key = req.headers["sec-websocket-key"];
                if (typeof key !== "string" || !key) {
                    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
                    socket.destroy();
                    return;
                }
                socket.write(
                    [
                        "HTTP/1.1 101 Switching Protocols",
                        "Upgrade: websocket",
                        "Connection: Upgrade",
                        `Sec-WebSocket-Accept: ${websocketAcceptKey(key)}`,
                        "\r\n",
                    ].join("\r\n"),
                );

                const connection = {
                    udid,
                    socket,
                    buffer: Buffer.alloc(0),
                    queue: Promise.resolve(),
                    lastEvent: null,
                    blocked: false,
                    closePromise: null,
                };
                touchConnections.add(connection);
                socket.on("close", () => {
                    touchConnections.delete(connection);
                    void closeTouchConnection(connection);
                });
                socket.on("data", (chunk) => {
                    connection.queue = connection.queue
                        .then(async () => {
                            if (connection.blocked) {
                                return;
                            }
                            if (!acceptingManualInput) {
                                connection.blocked = true;
                                await cancelTouchEvent(connection.lastEvent);
                                connection.lastEvent = null;
                                socket.end();
                                return;
                            }
                            connection.buffer = Buffer.concat([connection.buffer, chunk]);
                            const parsed = parseWebSocketFrames(connection.buffer);
                            connection.buffer = parsed.remaining;
                            for (const frame of parsed.messages) {
                                if (frame.opcode === 0x8) {
                                    socket.write(websocketCloseFrame());
                                    socket.end();
                                    return;
                                }
                                if (frame.opcode !== 0x1) {
                                    continue;
                                }
                                const currentState = manager.getCachedDeviceState(connection.udid);
                                if (currentState.lease?.active || currentState.controlPending) {
                                    connection.blocked = true;
                                    await cancelTouchEvent(connection.lastEvent);
                                    connection.lastEvent = null;
                                    socket.end();
                                    return;
                                }
                                const event = JSON.parse(frame.payload.toString("utf8"));
                                await manager.notifyTouch({
                                    udid: connection.udid,
                                    phase: event?.phase,
                                    x: event?.x,
                                    y: event?.y,
                                    coordinateSpace: event?.coordinateSpace,
                                });
                                connection.lastEvent = { ...event, udid: connection.udid };
                            }
                        })
                        .catch(() => {
                            socket.destroy();
                        });
                });
            } catch {
                socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
                socket.destroy();
            }
        })();
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const bootstrap = new URLSearchParams();
    if (udid) {
        const state = manager.snapshot(udid);
        bootstrap.set("family", state.deviceFamily ?? "phone");
        bootstrap.set("orientation", state.orientation ?? "portrait");
        bootstrap.set("width", String(state.screen?.width ?? ""));
        bootstrap.set("height", String(state.screen?.height ?? ""));
    }
    const bootstrapQuery = bootstrap.size > 0 ? `?${bootstrap}` : "";

    return {
        url: `http://127.0.0.1:${port}${basePath}/${bootstrapQuery}`,
        async rebindDevice(nextUdid) {
            await stopActiveConnections({ blockManualInput: true });
            udid = nextUdid;
            acceptingManualInput = true;
            subscribeToDevice();
            writeStateEvent();
        },
        async close() {
            if (unsub) {
                unsub();
                unsub = null;
            }
            if (unregisterManualInputStop) {
                unregisterManualInputStop();
                unregisterManualInputStop = null;
            }
            for (const client of sseClients) {
                client.end();
            }
            sseClients.clear();
            await stopActiveConnections({ blockManualInput: true });
            await new Promise((resolve) => server.close(() => resolve()));
        },
    };
}
