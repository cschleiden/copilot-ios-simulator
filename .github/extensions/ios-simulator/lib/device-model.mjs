export const DEFAULT_LEASE_TTL_SECONDS = 120;
export const MAX_LEASE_TTL_SECONDS = 900;
export const STREAM_CODECS = new Set(["mjpeg", "h264"]);
export const STREAM_FPS = new Set([30, 60]);
export const STREAM_RESOLUTIONS = new Set([25, 50, 100]);
export const KEYBOARD_MODES = new Set(["hardware", "software"]);

export function nowIso() {
    return new Date().toISOString();
}

export function clampTtlSeconds(ttlSeconds) {
    if (typeof ttlSeconds !== "number" || Number.isNaN(ttlSeconds)) {
        return DEFAULT_LEASE_TTL_SECONDS;
    }
    return Math.max(15, Math.min(MAX_LEASE_TTL_SECONDS, Math.floor(ttlSeconds)));
}

export function timestampName() {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

export function deviceFamily(device) {
    const type = `${device.deviceTypeIdentifier ?? ""} ${device.name ?? ""}`.toLowerCase();
    if (type.includes("ipad")) {
        return "tablet";
    }
    return "phone";
}

export function fallbackScreen(device) {
    const family = deviceFamily(device);
    if (family === "tablet") {
        return {
            width: 1640,
            height: 2360,
            source: "device-type",
            family,
        };
    }
    return {
        width: 1290,
        height: 2796,
        source: "device-type",
        family,
    };
}

export function normalizeRuntime(runtime) {
    const identifier = String(runtime ?? "").replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, "");
    const match = identifier.match(/^([A-Za-z]+)-(\d+(?:-\d+)*)$/);
    if (!match) {
        return identifier.replaceAll("-", " ");
    }
    return `${match[1]} ${match[2].replaceAll("-", ".")}`;
}

export function shortUdid(udid) {
    return typeof udid === "string" && udid.length > 8 ? udid.slice(0, 8) : udid;
}

export function flattenDevices(devicesByRuntime) {
    const flattened = [];
    for (const [runtime, devices] of Object.entries(devicesByRuntime ?? {})) {
        for (const device of devices ?? []) {
            flattened.push({
                runtime,
                udid: device.udid,
                name: device.name,
                state: device.state,
                isAvailable: device.isAvailable !== false,
                deviceTypeIdentifier: device.deviceTypeIdentifier,
            });
        }
    }
    flattened.sort((a, b) => {
        const bootRankA = a.state === "Booted" ? 0 : 1;
        const bootRankB = b.state === "Booted" ? 0 : 1;
        if (bootRankA !== bootRankB) {
            return bootRankA - bootRankB;
        }
        return a.name.localeCompare(b.name);
    });
    return flattened;
}
