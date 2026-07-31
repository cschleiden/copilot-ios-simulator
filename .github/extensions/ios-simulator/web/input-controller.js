const supportedKeyCodes = new Set([
    "Enter", "Escape", "Backspace", "Tab", "Space", "Minus", "Equal", "BracketLeft", "BracketRight",
    "Backslash", "Semicolon", "Quote", "Backquote", "Comma", "Period", "Slash", "CapsLock",
    "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
    "PrintScreen", "ScrollLock", "Pause", "Insert", "Home", "PageUp", "Delete", "End", "PageDown",
    "ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp",
]);

export function createInputController({
    elements,
    apiUrl,
    fetchJson,
    getState,
    isControlUnavailable,
    screenPointToSourcePoint,
    setNotice,
    setState,
    withPending,
}) {
    let activePointer = null;

    function shouldForwardKeyboardEvent(event) {
        return event.code.startsWith("Key") || event.code.startsWith("Digit") || supportedKeyCodes.has(event.code);
    }

    function forwardKeyboardEvent(event) {
        const state = getState();
        if (!state || state.state !== "Booted" || isControlUnavailable()) {
            return;
        }
        if ((state.keyboard?.mode ?? "hardware") === "software" || !shouldForwardKeyboardEvent(event)) {
            return;
        }
        const target = event.target;
        if (target instanceof Element && target.closest("button, select, input, textarea, [contenteditable='true']")) {
            return;
        }
        const modifiers = [];
        if (event.shiftKey) modifiers.push("shift");
        if (event.ctrlKey) modifiers.push("control");
        if (event.altKey) modifiers.push("option");
        if (event.metaKey) modifiers.push("command");
        void fetchJson("api/input/key", { code: event.code, modifiers }).catch((error) =>
            setNotice(error.message, true),
        );
        event.preventDefault();
    }

    function normalizedScreenPoint(event) {
        const rect = elements.screenWindow.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
            return null;
        }
        return screenPointToSourcePoint({
            x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
            y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
        });
    }

    function postTouchPhase(phase, point) {
        return fetchJson("api/input/touch", {
            phase,
            x: point.x,
            y: point.y,
            coordinateSpace: "normalized",
        });
    }

    function createTouchStream() {
        if (!("WebSocket" in window)) {
            return null;
        }
        const url = apiUrl("api/input/touch-ws");
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        const socket = new WebSocket(url);
        const queued = [];
        let opened = false;
        let closed = false;
        let failed = false;
        const eventPayload = (phase, point) => ({
            phase,
            x: point.x,
            y: point.y,
            coordinateSpace: "normalized",
        });
        const fallback = (events) => {
            failed = true;
            for (const event of events) {
                void postTouchPhase(event.phase, event).catch((error) => setNotice(error.message, true));
            }
        };
        socket.addEventListener("open", () => {
            opened = true;
            for (const event of queued.splice(0)) {
                socket.send(JSON.stringify(event));
            }
            if (closed) {
                socket.close();
            }
        });
        socket.addEventListener("error", () => {
            if (!closed) {
                fallback(queued.splice(0));
            }
        });
        socket.addEventListener("close", () => {
            if (!closed && !failed) {
                fallback(queued.splice(0));
            }
        });
        return {
            send(phase, point) {
                if (closed) {
                    return;
                }
                const event = eventPayload(phase, point);
                if (failed) {
                    void postTouchPhase(phase, point).catch((error) => setNotice(error.message, true));
                } else if (opened && socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify(event));
                } else {
                    queued.push(event);
                }
            },
            close() {
                if (closed) {
                    return;
                }
                closed = true;
                if (!opened) {
                    fallback(queued.splice(0));
                }
                if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
                    socket.close();
                }
            },
            abort() {
                if (closed) {
                    return;
                }
                closed = true;
                queued.length = 0;
                socket.close();
            },
        };
    }

    function dispatchTouch(phase, point, dispatcher = activePointer?.dispatcher) {
        if (dispatcher) {
            dispatcher.send(phase, point);
        } else {
            void postTouchPhase(phase, point).catch((error) => setNotice(error.message, true));
        }
    }

    function bind() {
        elements.screenWindow.addEventListener("pointerdown", (event) => {
            if (event.target.closest("button, summary, details, a, input, select")) {
                return;
            }
            const state = getState();
            if (!state || state.state !== "Booted" || isControlUnavailable()) {
                return;
            }
            const point = normalizedScreenPoint(event);
            if (!point) {
                return;
            }
            elements.viewport.focus();
            elements.screenWindow.setPointerCapture(event.pointerId);
            const dispatcher = createTouchStream();
            activePointer = {
                pointerId: event.pointerId,
                lastX: point.x,
                lastY: point.y,
                pendingMove: null,
                moveScheduled: false,
                ended: false,
                dispatcher,
            };
            dispatchTouch("down", point, dispatcher);
            event.preventDefault();
        });
        elements.screenWindow.addEventListener("pointermove", (event) => {
            if (!activePointer || activePointer.pointerId !== event.pointerId) {
                return;
            }
            const point = normalizedScreenPoint(event);
            if (!point) {
                return;
            }
            activePointer.lastX = point.x;
            activePointer.lastY = point.y;
            activePointer.pendingMove = point;
            if (!activePointer.moveScheduled) {
                activePointer.moveScheduled = true;
                requestAnimationFrame(() => {
                    if (!activePointer || activePointer.ended) {
                        return;
                    }
                    activePointer.moveScheduled = false;
                    const move = activePointer.pendingMove;
                    activePointer.pendingMove = null;
                    if (move) {
                        dispatchTouch("move", move, activePointer.dispatcher);
                    }
                });
            }
            event.preventDefault();
        });
        const finishPointer = (event, cancelled = false) => {
            if (!activePointer || activePointer.pointerId !== event.pointerId) {
                return;
            }
            const pointer = activePointer;
            activePointer = null;
            pointer.ended = true;
            if (elements.screenWindow.hasPointerCapture(event.pointerId)) {
                elements.screenWindow.releasePointerCapture(event.pointerId);
            }
            const state = getState();
            if (!state || state.state !== "Booted" || isControlUnavailable()) {
                pointer.dispatcher?.abort();
                return;
            }
            const point = normalizedScreenPoint(event);
            dispatchTouch(
                cancelled ? "cancel" : "up",
                { x: point?.x ?? pointer.lastX, y: point?.y ?? pointer.lastY },
                pointer.dispatcher,
            );
            pointer.dispatcher?.close();
            event.preventDefault();
        };
        elements.screenWindow.addEventListener("pointerup", (event) => finishPointer(event));
        elements.screenWindow.addEventListener("pointercancel", (event) => finishPointer(event, true));
        document.addEventListener("keydown", forwardKeyboardEvent, true);
        elements.takeBack.addEventListener("click", () => {
            void withPending(async () => {
                setState(await fetchJson("api/control/revoke", {}));
                setNotice("Control returned to user.");
            }).catch((error) => setNotice(error.message, true));
        });
    }

    return { bind };
}
