import { AppError } from "./errors.mjs";
import {
    flattenDevices,
    normalizeRuntime,
    deviceFamily,
    KEYBOARD_MODES,
} from "./device-model.mjs";
import { DeviceRegistry } from "./device-registry.mjs";
import { InputDispatcher } from "./input-dispatcher.mjs";
import { NativeBridge } from "./native-bridge.mjs";
import { ScreenService } from "./screen-service.mjs";
import { VideoRecordingService } from "./video-recording-service.mjs";

export class DeviceSessionManager {
    constructor({ nativeRoot } = {}) {
        this.state = new DeviceRegistry();
        this.artifactsRoot = null;
        this.keyboardSynchronized = new Set();
        this.manualInputStops = new Map();
        this.nativeBridge = nativeRoot ? new NativeBridge({ nativeRoot }) : null;
        this.screen = new ScreenService({
            state: this.state,
            nativeBridge: this.nativeBridge,
            artifactsRoot: () => this.artifactsRoot,
            ensureBooted: (udid) => this.ensureBooted(udid),
        });
        this.video = new VideoRecordingService({
            state: this.state,
            artifactsRoot: () => this.artifactsRoot,
            ensureBooted: (udid) => this.ensureBooted(udid),
        });
        this.input = new InputDispatcher({
            state: this.state,
            nativeBridge: this.nativeBridge,
            ensureBooted: (udid) => this.ensureBooted(udid),
            screenSize: (udid) => this.screen.screenSize(udid),
        });
    }

    setArtifactsRoot(artifactsRoot) {
        this.artifactsRoot = artifactsRoot;
    }

    subscribe(udid, handler) {
        return this.state.subscribe(udid, handler);
    }

    snapshot(udid) {
        return this.state.snapshot(udid);
    }

    getCachedDeviceState(udid) {
        return this.state.snapshot(udid);
    }

    attachInstance(udid, instanceId) {
        this.state.attachInstance(udid, instanceId);
    }

    detachInstance(udid, instanceId) {
        this.state.detachInstance(udid, instanceId);
    }

    registerManualInputStop(udid, handler) {
        let handlers = this.manualInputStops.get(udid);
        if (!handlers) {
            handlers = new Set();
            this.manualInputStops.set(udid, handlers);
        }
        handlers.add(handler);
        return () => {
            handlers.delete(handler);
            if (handlers.size === 0) {
                this.manualInputStops.delete(udid);
            }
        };
    }

    async stopManualInput(udid) {
        const handlers = Array.from(this.manualInputStops.get(udid) ?? []);
        await Promise.all(handlers.map((handler) => handler()));
    }

    assertNoActiveLease(udid) {
        this.state.assertNoActiveLease(udid);
    }

    hasActiveLease(udid) {
        return this.state.hasActiveLease(udid);
    }

    async acquireLease(input) {
        await this.refreshDevices();
        this.state.reserveLease(input);
        try {
            await this.stopManualInput(input.udid);
            return this.state.acquireLease(input);
        } catch (error) {
            this.state.cancelLeaseReservation(input.udid, input.ownerInstanceId);
            throw error;
        }
    }

    async renewLease(input) {
        return this.state.renewLease(input);
    }

    async releaseLease(input) {
        return this.state.releaseLease(input);
    }

    async revokeLease(udid) {
        return this.state.revokeLease(udid);
    }

    async withLeaseOperation(input, fn) {
        return await this.state.withLeaseOperation(input, fn);
    }

    async assertDeviceAvailable(udid) {
        await this.refreshDevices();
        const device = this.state.getDeviceOrThrow(udid);
        if (device.isAvailable === false) {
            throw new AppError("device_unavailable", `Simulator device is unavailable: ${device.name}`, 409);
        }
        return device;
    }

    async diagnoseNativeBackend() {
        if (!this.nativeBridge) {
            throw new AppError("native_bridge_unconfigured", "Native bridge path is not configured.", 500);
        }
        return await this.nativeBridge.send("diagnose");
    }

    async listDevicesFromBackend() {
        if (!this.nativeBridge) {
            throw new AppError("native_bridge_unconfigured", "Native bridge path is not configured.", 500);
        }
        const payload = await this.nativeBridge.send("listDevices");
        return flattenDevices(payload.devices);
    }

    async dispose() {
        await this.video.stopAll();
        await this.nativeBridge?.stop();
    }

    async refreshDevices() {
        const listed = await this.listDevicesFromBackend();
        this.state.updateFromList(listed);
        for (const device of listed) {
            if (device.state !== "Booted") {
                this.keyboardSynchronized.delete(device.udid);
            }
        }
        return listed;
    }

    async listDevices() {
        const devices = await this.refreshDevices();
        return devices.map((device) => ({
            udid: device.udid,
            name: device.name,
            runtime: device.runtime,
            runtimeLabel: normalizeRuntime(device.runtime),
            state: device.state,
            isAvailable: device.isAvailable,
            deviceTypeIdentifier: device.deviceTypeIdentifier,
            deviceFamily: deviceFamily(device),
        }));
    }

    async listDevicePicker(currentUdid) {
        await this.refreshDevices();
        return this.state.listDevicePicker(currentUdid);
    }

    async resolveDeviceUdid(preferredUdid) {
        const devices = await this.refreshDevices();
        if (devices.length === 0) {
            throw new AppError("no_simulators", "No iOS simulator devices are available.", 404);
        }

        if (preferredUdid) {
            const found = devices.find((device) => device.udid === preferredUdid);
            if (!found) {
                throw new AppError("unknown_device", `Simulator device not found: ${preferredUdid}`, 404);
            }
            if (found.isAvailable === false) {
                throw new AppError("device_unavailable", `Simulator device is unavailable: ${found.name}`, 409);
            }
            return found.udid;
        }

        const booted = devices.find((device) => device.state === "Booted" && device.isAvailable);
        if (booted) {
            return booted.udid;
        }

        const available = devices.find((device) => device.isAvailable);
        if (available) {
            return available.udid;
        }

        throw new AppError("no_available_device", "No available simulator device could be selected.", 404);
    }

    async getDeviceState(udid) {
        await this.refreshDevices();
        const device = this.state.getDeviceOrThrow(udid);
        if (device.state === "Booted") {
            await this.applyKeyboardMode(udid);
            await this.refreshScreenMetrics(udid);
        }
        return this.state.snapshot(udid);
    }

    async ensureBooted(udid) {
        await this.refreshDevices();
        const device = this.state.getDeviceOrThrow(udid);
        if (device.state !== "Booted") {
            this.prepareBoot(udid);
            return await this.completePreparedBoot(udid);
        }
        await this.applyKeyboardMode(udid);
        await this.refreshScreenMetrics(udid);
        return this.state.snapshot(udid);
    }

    async bootDevice(udid) {
        await this.refreshDevices();
        this.prepareBoot(udid);
        return await this.completePreparedBoot(udid);
    }

    prepareBoot(udid) {
        return this.state.setDeviceState(udid, "Booting");
    }

    async completePreparedBoot(udid) {
        try {
            await this.nativeBridge.send("boot", { udid });
        } catch (error) {
            await this.refreshDevices();
            throw error;
        }
        await this.refreshDevices();
        await this.applyKeyboardMode(udid);
        await this.refreshScreenMetrics(udid);
        this.state.notify(udid);
        return this.state.snapshot(udid);
    }

    async shutdownDevice(udid) {
        await this.nativeBridge.send("shutdown", { udid });
        await this.refreshDevices();
        this.state.notify(udid);
        return this.state.snapshot(udid);
    }

    async restartDevice(udid) {
        await this.nativeBridge.send("shutdown", { udid });
        await this.refreshDevices();
        this.state.setDeviceState(udid, "Booting");
        try {
            await this.nativeBridge.send("boot", { udid });
        } catch (error) {
            await this.refreshDevices();
            throw error;
        }
        await this.refreshDevices();
        await this.applyKeyboardMode(udid);
        await this.refreshScreenMetrics(udid);
        this.state.notify(udid);
        return this.state.snapshot(udid);
    }

    captureScreen(udid) {
        return this.screen.captureScreen(udid);
    }

    startVideoRecording(input) {
        return this.video.start(input);
    }

    stopVideoRecording(input) {
        return this.video.stop(input);
    }

    getFramePng(udid) {
        return this.screen.getFramePng(udid);
    }

    refreshScreenMetrics(udid) {
        return this.screen.refreshScreenMetrics(udid);
    }

    setStreamPreferences(udid, preferences) {
        return this.state.setStreamPreferences(udid, preferences);
    }

    async setKeyboardMode(udid, mode) {
        if (!KEYBOARD_MODES.has(mode)) {
            throw new AppError("unsupported_keyboard_mode", `Unsupported keyboard mode: ${mode}`, 400);
        }
        await this.assertDeviceAvailable(udid);
        if (!this.nativeBridge) {
            throw new AppError("native_bridge_unconfigured", "Native bridge path is not configured.", 500);
        }
        await this.applyKeyboardMode(udid, mode, true);
        return this.state.setKeyboardMode(udid, mode);
    }

    async applyKeyboardMode(udid, mode = null, force = false) {
        if (!force && this.keyboardSynchronized.has(udid)) {
            return;
        }
        if (!this.nativeBridge) {
            throw new AppError("native_bridge_unconfigured", "Native bridge path is not configured.", 500);
        }
        const device = this.state.getDeviceOrThrow(udid);
        if (device.state !== "Booted") {
            return;
        }
        const nextMode = mode ?? device.keyboard?.mode ?? "hardware";
        await this.nativeBridge.send("setHardwareKeyboard", {
            udid,
            connected: nextMode !== "software",
        });
        this.keyboardSynchronized.add(udid);
    }

    createMjpegStream(input) {
        return this.screen.createMjpegStream(input);
    }

    createH264Stream(input) {
        return this.screen.createH264Stream(input);
    }

    rotateDevice(...args) {
        return this.input.rotateDevice(...args);
    }

    goHome(input) {
        return this.input.goHome(input);
    }

    pressButton(input, maybeButton) {
        return this.input.pressButton(input, maybeButton);
    }

    tap(input) {
        return this.input.tap(input);
    }

    swipe(input) {
        return this.input.swipe(input);
    }

    touch(input) {
        return this.input.touch(input);
    }

    prepareTouchStream(udid) {
        return this.input.prepareTouchStream(udid);
    }

    notifyTouch(input) {
        return this.input.notifyTouch(input);
    }

    sendKey(input) {
        return this.input.sendKey(input);
    }

    sendText(input) {
        return this.input.sendText(input);
    }

    performInputs(input) {
        return this.input.performInputs(input);
    }
}
