import { randomUUID } from "node:crypto";
import { AppError } from "./errors.mjs";
import {
    clampTtlSeconds,
    deviceFamily,
    fallbackScreen,
    KEYBOARD_MODES,
    normalizeRuntime,
    nowIso,
    shortUdid,
    STREAM_CODECS,
    STREAM_FPS,
    STREAM_RESOLUTIONS,
} from "./device-model.mjs";

export class DeviceRegistry {
    constructor() {
        this.devices = new Map();
        this.subscribers = new Map();
    }

    subscribe(udid, handler) {
        let set = this.subscribers.get(udid);
        if (!set) {
            set = new Set();
            this.subscribers.set(udid, set);
        }
        set.add(handler);
        return () => {
            const current = this.subscribers.get(udid);
            if (!current) {
                return;
            }
            current.delete(handler);
            if (current.size === 0) {
                this.subscribers.delete(udid);
            }
        };
    }

    notify(udid) {
        const handlers = this.subscribers.get(udid);
        if (!handlers || handlers.size === 0) {
            return;
        }
        const snapshot = this.snapshot(udid);
        for (const handler of handlers) {
            handler(snapshot);
        }
    }

    updateFromList(devices) {
        for (const device of devices) {
            const session = this.upsertDevice(device);
            this.notify(session.udid);
        }
    }

    upsertDevice(device) {
        const existing = this.devices.get(device.udid);
        if (existing) {
            existing.name = device.name;
            existing.runtime = device.runtime;
            existing.state = device.state;
            existing.isAvailable = device.isAvailable;
            existing.deviceTypeIdentifier = device.deviceTypeIdentifier;
            existing.deviceFamily = deviceFamily(device);
            existing.screen ??= fallbackScreen(device);
            existing.keyboard ??= { mode: "hardware" };
            existing.lastSeenAt = nowIso();
            this.clearExpiredLease(existing);
            return existing;
        }

        const created = {
            udid: device.udid,
            name: device.name,
            runtime: device.runtime,
            state: device.state,
            isAvailable: device.isAvailable,
            deviceTypeIdentifier: device.deviceTypeIdentifier,
            deviceFamily: deviceFamily(device),
            screen: fallbackScreen(device),
            orientation: "portrait",
            stream: {
                codec: "h264",
                fps: 60,
                resolution: 100,
                h264Available: true,
            },
            keyboard: {
                mode: "hardware",
            },
            lastSeenAt: nowIso(),
            lease: null,
            leaseReservation: null,
            leaseTimer: null,
            instanceIds: new Set(),
        };
        this.devices.set(device.udid, created);
        return created;
    }

    getDeviceOrThrow(udid) {
        const device = this.devices.get(udid);
        if (!device) {
            throw new AppError("unknown_device", `Simulator device not found: ${udid}`, 404);
        }
        this.clearExpiredLease(device);
        return device;
    }

    clearExpiredLease(device) {
        if (!device.lease) {
            return;
        }
        if (new Date(device.lease.expiresAt).getTime() > Date.now()) {
            return;
        }
        if (device.leaseTimer) {
            clearTimeout(device.leaseTimer);
            device.leaseTimer = null;
        }
        device.lease = null;
    }

    scheduleLeaseExpiry(device) {
        if (device.leaseTimer) {
            clearTimeout(device.leaseTimer);
            device.leaseTimer = null;
        }
        if (!device.lease) {
            return;
        }

        const msUntilExpiry = Math.max(0, new Date(device.lease.expiresAt).getTime() - Date.now());
        device.leaseTimer = setTimeout(() => {
            this.clearExpiredLease(device);
            this.notify(device.udid);
        }, msUntilExpiry + 50);
    }

    snapshot(udid) {
        const device = this.getDeviceOrThrow(udid);
        const lease = device.lease
            ? {
                  leaseId: device.lease.leaseId,
                  owner: device.lease.owner,
                  ownerInstanceId: device.lease.ownerInstanceId,
                  reason: device.lease.reason,
                  acquiredAt: device.lease.acquiredAt,
                  expiresAt: device.lease.expiresAt,
                  currentOperation: device.lease.currentOperation,
                  active: true,
              }
            : {
                  active: false,
              };

        return {
            udid: device.udid,
            name: device.name,
            runtime: device.runtime,
            state: device.state,
            isAvailable: device.isAvailable,
            deviceTypeIdentifier: device.deviceTypeIdentifier,
            deviceFamily: device.deviceFamily,
            screen: device.screen,
            orientation: device.orientation,
            stream: device.stream,
            keyboard: device.keyboard,
            controlPending: Boolean(device.leaseReservation),
            lease,
        };
    }

    listDevicePicker(currentUdid) {
        const groups = {
            booted: [],
            available: [],
            unavailable: [],
        };

        for (const device of this.devices.values()) {
            const item = {
                udid: device.udid,
                shortUdid: shortUdid(device.udid),
                name: device.name,
                runtime: device.runtime,
                runtimeLabel: normalizeRuntime(device.runtime),
                state: device.state,
                isAvailable: device.isAvailable !== false,
                deviceTypeIdentifier: device.deviceTypeIdentifier,
                deviceFamily: device.deviceFamily,
                isCurrent: device.udid === currentUdid,
                isOpen: device.instanceIds.size > 0,
            };
            if (!item.isAvailable) {
                groups.unavailable.push(item);
            } else if (item.state === "Booted") {
                groups.booted.push(item);
            } else {
                groups.available.push(item);
            }
        }

        for (const items of Object.values(groups)) {
            items.sort((a, b) => a.name.localeCompare(b.name) || a.runtimeLabel.localeCompare(b.runtimeLabel));
        }

        return { currentUdid, groups };
    }

    attachInstance(udid, instanceId) {
        const device = this.getDeviceOrThrow(udid);
        device.instanceIds.add(instanceId);
        this.notify(udid);
    }

    detachInstance(udid, instanceId) {
        const device = this.devices.get(udid);
        if (!device) {
            return;
        }
        device.instanceIds.delete(instanceId);
        if (device.leaseReservation?.ownerInstanceId === instanceId) {
            device.leaseReservation = null;
        }
        if (device.lease && device.lease.ownerInstanceId === instanceId) {
            device.lease = null;
            this.scheduleLeaseExpiry(device);
        }
        this.notify(udid);
    }

    assertNoActiveLease(udid) {
        const device = this.getDeviceOrThrow(udid);
        if (device.lease || device.leaseReservation) {
            throw new AppError(
                "lease_active",
                `Simulator ${device.name ?? udid} is currently controlled by an agent.`,
                423,
            );
        }
    }

    hasActiveLease(udid) {
        const device = this.getDeviceOrThrow(udid);
        return Boolean(device.lease || device.leaseReservation);
    }

    reserveLease({ udid, ownerInstanceId }) {
        const device = this.getDeviceOrThrow(udid);
        if (device.lease || device.leaseReservation) {
            throw new AppError("device_busy", `Simulator ${udid} is currently controlled by another lease.`, 409, {
                lease: device.lease,
            });
        }
        device.leaseReservation = { ownerInstanceId };
        this.notify(udid);
    }

    cancelLeaseReservation(udid, ownerInstanceId) {
        const device = this.getDeviceOrThrow(udid);
        if (device.leaseReservation?.ownerInstanceId === ownerInstanceId) {
            device.leaseReservation = null;
            this.notify(udid);
        }
    }

    acquireLease({ udid, ownerInstanceId, reason, ttlSeconds }) {
        const device = this.getDeviceOrThrow(udid);
        if (device.lease || device.leaseReservation?.ownerInstanceId !== ownerInstanceId) {
            throw new AppError("lease_reservation_lost", "Control lease reservation is no longer available.", 409);
        }

        const ttl = clampTtlSeconds(ttlSeconds);
        const acquiredAt = new Date();
        const expiresAt = new Date(acquiredAt.getTime() + ttl * 1000);
        device.lease = {
            leaseId: randomUUID(),
            owner: "agent",
            ownerInstanceId,
            reason,
            acquiredAt: acquiredAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
            currentOperation: null,
        };
        device.leaseReservation = null;
        this.scheduleLeaseExpiry(device);
        this.notify(udid);
        return this.snapshot(udid);
    }

    renewLease({ udid, leaseId, ttlSeconds }) {
        const device = this.getDeviceOrThrow(udid);
        if (!device.lease || device.lease.leaseId !== leaseId) {
            throw new AppError("lease_not_found", "Control lease not found or already expired.", 404);
        }

        const ttl = clampTtlSeconds(ttlSeconds);
        device.lease.expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
        this.scheduleLeaseExpiry(device);
        this.notify(udid);
        return this.snapshot(udid);
    }

    releaseLease({ udid, leaseId }) {
        const device = this.getDeviceOrThrow(udid);
        if (!device.lease || device.lease.leaseId !== leaseId) {
            throw new AppError("lease_not_found", "Control lease not found or already expired.", 404);
        }
        device.lease = null;
        this.scheduleLeaseExpiry(device);
        this.notify(udid);
        return this.snapshot(udid);
    }

    revokeLease(udid) {
        const device = this.getDeviceOrThrow(udid);
        if (device.lease) {
            device.lease = null;
            this.scheduleLeaseExpiry(device);
            this.notify(udid);
        }
        return this.snapshot(udid);
    }

    assertLease({ udid, leaseId }) {
        const device = this.getDeviceOrThrow(udid);
        if (!device.lease || device.lease.leaseId !== leaseId) {
            throw new AppError("lease_revoked", "Control lease was revoked or expired.", 409);
        }
        return device;
    }

    async withLeaseOperation({ udid, leaseId, operation }, fn) {
        const device = this.assertLease({ udid, leaseId });
        device.lease.currentOperation = operation;
        this.notify(udid);
        try {
            return await fn();
        } finally {
            const latest = this.devices.get(udid);
            if (latest?.lease && latest.lease.leaseId === leaseId) {
                latest.lease.currentOperation = null;
                this.notify(udid);
            }
        }
    }

    updateScreenMetrics(udid, size, source = "stream") {
        const device = this.getDeviceOrThrow(udid);
        if (!size?.width || !size?.height) {
            throw new AppError("invalid_screen_metrics", "Screen metrics must include width and height.", 500);
        }
        device.screen = {
            width: size.width,
            height: size.height,
            source,
            family: device.deviceFamily,
            updatedAt: nowIso(),
        };
        return device.screen;
    }

    setStreamPreferences(udid, { codec, fps, resolution }) {
        const device = this.getDeviceOrThrow(udid);
        const nextCodec = codec ?? device.stream.codec;
        const nextFps = fps ?? device.stream.fps;
        const nextResolution = resolution ?? device.stream.resolution ?? 100;

        if (!STREAM_CODECS.has(nextCodec)) {
            throw new AppError("unsupported_stream_codec", `Unsupported stream codec: ${nextCodec}`, 400);
        }
        if (!STREAM_FPS.has(nextFps)) {
            throw new AppError("unsupported_stream_fps", `Unsupported stream FPS: ${nextFps}`, 400);
        }
        if (!STREAM_RESOLUTIONS.has(nextResolution)) {
            throw new AppError(
                "unsupported_stream_resolution",
                `Unsupported stream resolution: ${nextResolution}%`,
                400,
            );
        }

        device.stream = {
            ...device.stream,
            codec: nextCodec,
            fps: nextFps,
            resolution: nextResolution,
        };
        this.notify(udid);
        return this.snapshot(udid);
    }

    setKeyboardMode(udid, mode) {
        const device = this.getDeviceOrThrow(udid);
        if (!KEYBOARD_MODES.has(mode)) {
            throw new AppError("unsupported_keyboard_mode", `Unsupported keyboard mode: ${mode}`, 400);
        }

        device.keyboard = {
            ...device.keyboard,
            mode,
        };
        this.notify(udid);
        return this.snapshot(udid);
    }

    setDeviceState(udid, state) {
        const device = this.getDeviceOrThrow(udid);
        device.state = state;
        this.notify(udid);
        return this.snapshot(udid);
    }

    setOrientation(udid, orientation) {
        const device = this.getDeviceOrThrow(udid);
        device.orientation = orientation;
        this.notify(udid);
        return this.snapshot(udid);
    }
}
