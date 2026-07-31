import { renderIcon } from "./icons.js";
import { applyDeviceMetrics, displayScreenMetrics, fitDeviceFrame } from "./device-frame.js";
import { createApiClient } from "./api-client.js";
import { createDevicePicker } from "./device-picker.js";
import { createH264StreamController } from "./h264-stream.js";
import { createInputController } from "./input-controller.js";

const elements = {
    deviceName: document.getElementById("device-name"),
    devicePicker: document.getElementById("device-picker"),
    devicePickerButton: document.getElementById("device-picker-button"),
    devicePickerMenu: document.getElementById("device-picker-menu"),
    devicePickerContent: document.getElementById("device-picker-content"),
    viewport: document.getElementById("viewport"),
    phoneFrame: document.getElementById("phone-frame"),
    screen: document.getElementById("screen"),
    screenWindow: document.getElementById("screen").closest(".screen-window"),
    h264Screen: document.getElementById("h264-screen"),
    screenMessage: document.getElementById("screen-message"),
    screenStatus: document.getElementById("screen-status"),
    poweredOffTitle: document.getElementById("powered-off-title"),
    bootSimulator: document.getElementById("boot-simulator"),
    retryError: document.getElementById("retry-error"),
    errorDetails: document.getElementById("error-details"),
    streamCodec: document.getElementById("stream-codec"),
    streamFps: document.getElementById("stream-fps"),
    streamResolution: document.getElementById("stream-resolution"),
    keyboardModeButton: document.getElementById("keyboard-mode-button"),
    overlay: document.getElementById("overlay"),
    overlayReason: document.getElementById("overlay-reason"),
    overlayOperation: document.getElementById("overlay-operation"),
    overlayExpiry: document.getElementById("overlay-expiry"),
    takeBack: document.getElementById("take-back"),
};

const toolbarButtons = {
    shutdown: document.querySelector('[data-action="shutdown"]'),
    home: document.querySelector('[data-action="home"]'),
    rotateRight: document.querySelector('[data-action="rotate-right"]'),
    keyboardMode: document.querySelector('[data-action="keyboard-mode"]'),
};

const { fetchJson, url: apiUrl } = createApiClient(window.location.href);
const bootstrapParams = new URLSearchParams(window.location.search);
const bootstrapMetrics = {
    family: bootstrapParams.get("family") ?? "phone",
    orientation: bootstrapParams.get("orientation") ?? "portrait",
    screen: {
        width: Number(bootstrapParams.get("width")) || undefined,
        height: Number(bootstrapParams.get("height")) || undefined,
    },
};
const noImageDataUrl =
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
const frameElements = {
    viewport: elements.viewport,
    phoneFrame: elements.phoneFrame,
};

let state = null;
let pending = false;
let streamRevision = 0;
let activeStreamKey = "";
let lastScreenSourceSize = null;
let eventSource = null;
let eventStreamErrorTimer = null;
let screenError = null;
const keyboardModeCopy = {
    hardware: {
        title: "Hardware keyboard on. Click to use software keyboard.",
    },
    software: {
        title: "Software keyboard on. Click to use hardware keyboard.",
    },
};

function agentControlUnavailable(currentState = state) {
    return currentState?.lease?.active === true || currentState?.controlPending === true;
}

function normalizeKeyboardMode(mode) {
    return mode === "software" ? "software" : "hardware";
}

function nextKeyboardMode(currentMode) {
    return normalizeKeyboardMode(currentMode) === "hardware" ? "software" : "hardware";
}

function updateKeyboardModeButton() {
    const mode = normalizeKeyboardMode(state?.keyboard?.mode);
    const copy = keyboardModeCopy[mode];
    elements.keyboardModeButton.dataset.keyboardMode = mode;
    elements.keyboardModeButton.title = copy.title;
    elements.keyboardModeButton.setAttribute("aria-label", copy.title);
    elements.keyboardModeButton.setAttribute("aria-pressed", String(mode === "hardware"));
}

function sourceTransformForOrientation(sourceSize) {
    if (!sourceSize) {
        return { rotation: "rotate(0deg)", swapsAxes: false };
    }
    const orientation = state?.orientation ?? "portrait";
    const sourceLandscape = sourceSize.width > sourceSize.height;
    const displaySize = displayScreenMetrics(sourceSize, state?.deviceFamily, orientation);
    const displayLandscape = displaySize.width > displaySize.height;
    const swapsAxes = sourceLandscape !== displayLandscape;

    if (orientation === "portrait-upside-down") {
        return { rotation: "rotate(180deg)", swapsAxes };
    }
    if (swapsAxes && orientation === "landscape-left") {
        return { rotation: "rotate(90deg)", swapsAxes };
    }
    if (swapsAxes && orientation === "landscape-right") {
        return { rotation: "rotate(-90deg)", swapsAxes };
    }
    return { rotation: "rotate(0deg)", swapsAxes };
}

function updateScreenLayerPresentation(sourceSize = lastScreenSourceSize) {
    lastScreenSourceSize = sourceSize;
    if (!sourceSize) {
        elements.screenWindow.style.removeProperty("--screen-layer-width");
        elements.screenWindow.style.removeProperty("--screen-layer-height");
        elements.screenWindow.style.removeProperty("--screen-layer-transform");
        return;
    }

    const { rotation, swapsAxes } = sourceTransformForOrientation(sourceSize);
    const rect = elements.screenWindow.getBoundingClientRect();
    elements.screenWindow.style.setProperty("--screen-layer-transform", rotation);
    elements.screenWindow.style.setProperty(
        "--screen-layer-width",
        swapsAxes ? `${rect.height}px` : "100%",
    );
    elements.screenWindow.style.setProperty(
        "--screen-layer-height",
        swapsAxes ? `${rect.width}px` : "100%",
    );
}

function screenPointToSourcePoint(point) {
    const { swapsAxes } = sourceTransformForOrientation(lastScreenSourceSize);
    const orientation = state?.orientation ?? "portrait";
    if (orientation === "portrait-upside-down") {
        return { ...point, x: 1 - point.x, y: 1 - point.y };
    }

    if (swapsAxes && orientation === "landscape-left") {
        return { ...point, x: point.y, y: 1 - point.x };
    }
    if (swapsAxes && orientation === "landscape-right") {
        return { ...point, x: 1 - point.y, y: point.x };
    }
    return point;
}

function hydrateIcons() {
    for (const button of document.querySelectorAll("[data-icon]")) {
        const iconName = button.dataset.icon;
        button.innerHTML = renderIcon(iconName);
    }
}

function setNotice(message, isError = false) {
    if (isError) {
        showScreenError(message);
    }
}

function setScreenMode(mode) {
    elements.screenWindow.classList.toggle("h264-active", mode === "h264");
    if (mode !== "h264") {
        const context = elements.h264Screen.getContext("2d");
        context?.clearRect(0, 0, elements.h264Screen.width, elements.h264Screen.height);
    }
}

function setScreenStatus(message, { error = false, poweredOff = false, stateName = "" } = {}) {
    elements.screenStatus.textContent = message;
    elements.screenMessage.classList.toggle("error", error);
    elements.screenMessage.classList.toggle("powered-off", poweredOff);
    elements.screenMessage.dataset.state = stateName;
}

function showScreenError(details) {
    screenError = String(details || "Unknown simulator error.");
    h264Stream.stop();
    elements.screen.src = noImageDataUrl;
    elements.screen.classList.remove("has-frame");
    elements.screenWindow.classList.remove("has-frame");
    elements.errorDetails.textContent = screenError;
    elements.errorDetails.closest("details").open = false;
    setScreenStatus("Simulator error. Retry or show details.", { error: true, stateName: "error" });
}

function clearScreenError() {
    screenError = null;
    elements.errorDetails.textContent = "";
    elements.errorDetails.closest("details").open = false;
    elements.screenMessage.classList.remove("error");
}

async function retryScreenError() {
    if (pending) {
        return;
    }
    pending = true;
    elements.retryError.disabled = true;
    try {
        await loadState();
        await devicePicker.refresh();
        clearScreenError();
        setScreenStatus("Retrying simulator");
        reconnectStream();
    } finally {
        pending = false;
        elements.retryError.disabled = false;
        render();
    }
}

function inactiveScreenStatus() {
    if (state?.state === "Booting") {
        return "Simulator is booting";
    }
    if (state?.state === "Unassigned") {
        return "No simulator selected";
    }
    return "Simulator powered off";
}

function leaseRemainingLabel(lease) {
    if (!lease?.active) {
        return "";
    }
    const remainingMs = Math.max(0, new Date(lease.expiresAt).getTime() - Date.now());
    const seconds = Math.ceil(remainingMs / 1000);
    return `${seconds}s remaining`;
}

function render() {
    if (!state) {
        return;
    }

    const leaseActive = state.lease?.active === true;
    const controlUnavailable = leaseActive || state.controlPending === true;
    const booted = state.state === "Booted";
    const booting = state.state === "Booting";
    const unassigned = state.state === "Unassigned";
    elements.deviceName.textContent = unassigned ? "Pick device" : (state.name ?? state.udid ?? "Unknown device");
    document.title = unassigned ? "iOS Simulator" : (state.name ?? "iOS Simulator");
    elements.devicePickerButton.dataset.deviceState = String(state.state ?? "unknown").toLowerCase();
    applyDeviceMetrics(frameElements, state.screen, state.deviceFamily, state.orientation);
    updateScreenLayerPresentation();
    requestAnimationFrame(() => fitDeviceFrame(frameElements));

    const disabled = pending || controlUnavailable;
    if (disabled) {
        devicePicker.close();
    }
    toolbarButtons.shutdown.disabled = disabled || !booted;
    toolbarButtons.home.disabled = disabled || !booted;
    toolbarButtons.rotateRight.disabled = disabled || !booted;
    toolbarButtons.keyboardMode.disabled = disabled || !booted;
    elements.bootSimulator.disabled = disabled || booted || booting || unassigned;
    elements.poweredOffTitle.textContent =
        state.state === "ShuttingDown"
            ? "Shutting down…"
            : unassigned
              ? "Pick device"
              : "Simulator not booted";
    elements.bootSimulator.hidden = unassigned || state.state === "ShuttingDown";
    elements.streamCodec.disabled = disabled || !booted;
    elements.streamFps.disabled = disabled || !booted;
    elements.streamResolution.disabled = disabled || !booted;
    elements.streamCodec.value = state.stream?.codec ?? "h264";
    elements.streamFps.value = String(state.stream?.fps ?? 60);
    elements.streamResolution.value = String(state.stream?.resolution ?? 100);
    updateKeyboardModeButton();
    devicePicker.render();

    elements.viewport.setAttribute("aria-busy", String(leaseActive));
    elements.overlay.classList.toggle("hidden", !leaseActive);
    if (leaseActive) {
        elements.overlayReason.textContent = state.lease.reason
            ? `Reason: ${state.lease.reason}`
            : "Reason: Agent control sequence";
        elements.overlayOperation.textContent = state.lease.currentOperation
            ? state.lease.currentOperation
            : "Waiting";
        elements.overlayExpiry.textContent = leaseRemainingLabel(state.lease);
    }

    ensureStream();
}

async function loadState() {
    state = await fetchJson("api/state");
    render();
}

async function withPending(action) {
    if (pending) {
        return;
    }
    pending = true;
    render();
    try {
        await action();
    } finally {
        pending = false;
        render();
    }
}

async function toolbarAction(path, body = {}) {
    await withPending(async () => {
        const payload = await fetchJson(path, body);
        if (payload?.udid && payload?.state) {
            state = payload;
        }
        render();
        await devicePicker.refresh();
    });
}

async function lightweightToolbarAction(path, body = {}) {
    const payload = await fetchJson(path, body);
    if (payload?.udid && payload?.state) {
        state = payload;
        render();
    }
}

function connectEvents() {
    eventSource?.close();
    eventSource = new EventSource(apiUrl("api/events"));
    eventSource.onmessage = (event) => {
        clearTimeout(eventStreamErrorTimer);
        eventStreamErrorTimer = null;
        try {
            state = JSON.parse(event.data);
            render();
        } catch {
            setNotice("Received malformed state update.", true);
        }
    };
    eventSource.onerror = () => {
        if (document.visibilityState === "hidden") {
            return;
        }
        clearTimeout(eventStreamErrorTimer);
        eventStreamErrorTimer = setTimeout(() => {
            if (eventSource?.readyState !== EventSource.OPEN) {
                setNotice("Event stream disconnected. Retrying…", true);
            }
        }, 1500);
    };
}

function streamUrl() {
    const codec = state?.stream?.codec ?? "h264";
    const fps = state?.stream?.fps ?? 60;
    const resolution = state?.stream?.resolution ?? 100;
    if (codec === "h264") {
        return apiUrl(`api/stream.h264?fps=${fps}&resolution=${resolution}&r=${streamRevision}`);
    }
    return apiUrl(`api/stream.mjpeg?fps=${fps}&resolution=${resolution}&r=${streamRevision}`);
}

function ensureStream() {
    if (screenError) {
        return;
    }
    if (!state || state.state !== "Booted") {
        activeStreamKey = "";
        h264Stream.stop();
        setScreenMode("mjpeg");
        elements.screen.src = noImageDataUrl;
        elements.screen.classList.remove("has-frame");
        elements.screenWindow.classList.remove("has-frame");
        setScreenStatus(inactiveScreenStatus(), {
            poweredOff: state?.state !== "Booting",
            stateName: String(state?.state ?? "").toLowerCase(),
        });
        return;
    }

    const codec = state.stream?.codec ?? "h264";
    const fps = state.stream?.fps ?? 60;
    const resolution = state.stream?.resolution ?? 100;
    const nextKey = `${codec}:${fps}:${resolution}:${streamRevision}`;
    if (nextKey === activeStreamKey) {
        return;
    }

    activeStreamKey = nextKey;
    if (codec === "h264") {
        startH264Stream(fps);
        return;
    }

    h264Stream.stop();
    setScreenMode("mjpeg");
    setScreenStatus(`Connecting MJPEG stream at ${fps} fps`);
    elements.screen.classList.remove("has-frame");
    elements.screenWindow.classList.remove("has-frame");
    elements.screen.src = streamUrl().toString();
}

function drawVideoFrame(frame) {
    if (state?.state !== "Booted") {
        return;
    }
    const width = frame.displayWidth || frame.codedWidth || frame.width;
    const height = frame.displayHeight || frame.codedHeight || frame.height;
    if (width && height && (elements.h264Screen.width !== width || elements.h264Screen.height !== height)) {
        elements.h264Screen.width = width;
        elements.h264Screen.height = height;
    }
    updateScreenLayerPresentation({ width, height });
    const context = h264CanvasContext();
    context.drawImage(frame, 0, 0, elements.h264Screen.width, elements.h264Screen.height);
    clearScreenError();
    elements.screenWindow.classList.add("has-frame");
    setScreenStatus("Simulator display ready");
}

function h264CanvasContext() {
    const context = elements.h264Screen.getContext("2d");
    if (!context) {
        throw new Error("Simulator screen canvas is unavailable.");
    }
    return context;
}

function handleH264StreamError(error) {
    setScreenStatus("H.264 stream failed.", { error: true });
    setNotice(error.message ?? String(error), true);
}

function startH264Stream(fps) {
    h264Stream.stop();
    setScreenMode("h264");
    elements.screen.src = noImageDataUrl;
    lastScreenSourceSize = null;
    updateScreenLayerPresentation(null);
    elements.screen.classList.remove("has-frame");
    elements.screenWindow.classList.remove("has-frame");
    setScreenStatus(`Connecting H.264 stream at ${fps} fps`);
    void h264Stream.start({ url: streamUrl(), fps });
}

function reconnectStream() {
    streamRevision += 1;
    activeStreamKey = "";
    ensureStream();
}

function bindToolbar() {
    toolbarButtons.shutdown.addEventListener("click", (event) => {
        event.preventDefault();
        if (!state || pending) {
            return;
        }
        setNotice("");
        void withPending(async () => {
            state = { ...state, state: "ShuttingDown" };
            render();
            const payload = await fetchJson("api/toolbar/shutdown", {});
            if (payload?.udid && payload?.state) {
                state = payload;
                render();
                await devicePicker.refresh();
            }
        }).catch((error) => {
            setNotice(error.message, true);
            void loadState().catch(() => {});
        });
    });
    elements.bootSimulator.addEventListener("click", (event) => {
        event.preventDefault();
        setNotice("");
        void toolbarAction("api/toolbar/boot").catch((error) => {
            setNotice(error.message, true);
            void loadState().catch(() => {});
        });
    });
    elements.retryError.addEventListener("click", (event) => {
        event.preventDefault();
        void retryScreenError().catch((error) => setNotice(error.message ?? String(error), true));
    });
    toolbarButtons.home.addEventListener("click", (event) => {
        event.preventDefault();
        void lightweightToolbarAction("api/toolbar/home").catch((error) => setNotice(error.message, true));
    });
    toolbarButtons.rotateRight.addEventListener("click", (event) => {
        event.preventDefault();
        void lightweightToolbarAction("api/toolbar/rotate", { direction: "right" }).catch((error) =>
            setNotice(error.message, true),
        );
    });
    toolbarButtons.keyboardMode.addEventListener("click", (event) => {
        event.preventDefault();
        const mode = nextKeyboardMode(state?.keyboard?.mode);
        void lightweightToolbarAction("api/keyboard/mode", { mode })
            .catch((error) => setNotice(error.message, true));
    });
    elements.streamCodec.addEventListener("change", () => {
        void toolbarAction("api/stream/preferences", {
            codec: elements.streamCodec.value,
            fps: Number(elements.streamFps.value),
            resolution: Number(elements.streamResolution.value),
        }).catch((error) => setNotice(error.message, true));
    });

    elements.streamFps.addEventListener("change", () => {
        void toolbarAction("api/stream/preferences", {
            codec: elements.streamCodec.value,
            fps: Number(elements.streamFps.value),
            resolution: Number(elements.streamResolution.value),
        }).catch((error) => setNotice(error.message, true));
    });

    elements.streamResolution.addEventListener("change", () => {
        void toolbarAction("api/stream/preferences", {
            codec: elements.streamCodec.value,
            fps: Number(elements.streamFps.value),
            resolution: Number(elements.streamResolution.value),
        }).catch((error) => setNotice(error.message, true));
    });
}

function bindSelectionGuards() {
    for (const eventName of ["selectstart", "dragstart"]) {
        document.addEventListener(eventName, (event) => {
            event.preventDefault();
        });
    }

    elements.viewport.addEventListener("contextmenu", (event) => {
        event.preventDefault();
    });
}

function bindScreenStatus() {
    elements.screen.addEventListener("load", () => {
        if (elements.screen.naturalWidth <= 1 || elements.screen.naturalHeight <= 1) {
            return;
        }
        if (state?.state === "Booted") {
            if (elements.screen.naturalWidth && elements.screen.naturalHeight) {
                updateScreenLayerPresentation({
                    width: elements.screen.naturalWidth,
                    height: elements.screen.naturalHeight,
                });
            }
            elements.screen.classList.add("has-frame");
            elements.screenWindow.classList.add("has-frame");
            clearScreenError();
            setScreenStatus("Simulator display ready");
        }
    });
    elements.screen.addEventListener("error", () => {
        elements.screen.classList.remove("has-frame");
        elements.screenWindow.classList.remove("has-frame");
        setScreenStatus("Screen failed to load.", { error: true });
        setNotice("Screen image failed to load.", true);
    });
}

function startLeaseTicker() {
    setInterval(() => {
        if (state?.lease?.active) {
            render();
        }
    }, 1000);
}

function bindResize() {
    if ("ResizeObserver" in window) {
        const observer = new ResizeObserver(() => {
            fitDeviceFrame(frameElements);
            updateScreenLayerPresentation();
        });
        observer.observe(elements.viewport);
        return;
    }
    window.addEventListener("resize", () => {
        fitDeviceFrame(frameElements);
        updateScreenLayerPresentation();
    });
}

const h264Stream = createH264StreamController({
    onFrame: drawVideoFrame,
    onError: handleH264StreamError,
});

const devicePicker = createDevicePicker({
    elements: {
        root: elements.devicePicker,
        button: elements.devicePickerButton,
        menu: elements.devicePickerMenu,
        content: elements.devicePickerContent,
    },
    fetchJson,
    getState: () => state,
    isPending: () => pending || agentControlUnavailable(),
    loadState,
    reconnectStream,
    setNotice,
    withPending,
});

const inputController = createInputController({
    elements,
    apiUrl,
    fetchJson,
    getState: () => state,
    isControlUnavailable: agentControlUnavailable,
    screenPointToSourcePoint,
    setNotice,
    setState: (nextState) => {
        state = nextState;
        render();
    },
    withPending,
});

async function init() {
    try {
        hydrateIcons();
        applyDeviceMetrics(
            frameElements,
            bootstrapMetrics.screen,
            bootstrapMetrics.family,
            bootstrapMetrics.orientation,
        );
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                document.documentElement.classList.remove("awaiting-initial-paint");
            });
        });
        devicePicker.bind();
        bindToolbar();
        bindSelectionGuards();
        inputController.bind();
        bindScreenStatus();
        bindResize();
        await loadState();
        await devicePicker.refresh();
        connectEvents();
        startLeaseTicker();
        reconnectStream();
    } catch (error) {
        setNotice(error.message ?? String(error), true);
    }
}

void init();
