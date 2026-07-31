import path from "node:path";
import { fileURLToPath } from "node:url";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { CanvasBindingStore } from "./lib/canvas-binding-store.mjs";
import { createCanvasServer } from "./lib/canvas-server.mjs";
import { DeviceSessionManager } from "./lib/device-session-manager.mjs";
import { AppError } from "./lib/errors.mjs";
import { actionSchemas, openInputSchema } from "./lib/schemas.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(__dirname, "web");
const instances = new Map();
const manager = new DeviceSessionManager({ nativeRoot: path.join(__dirname, "native") });
let canvasBindings = null;

function toCanvasError(error) {
    if (error instanceof CanvasError) {
        return error;
    }

    if (error instanceof AppError) {
        return new CanvasError(error.code, error.message);
    }

    const message = error instanceof Error ? error.message : String(error);
    return new CanvasError("internal_error", message);
}

async function withCanvasError(fn) {
    try {
        return await fn();
    } catch (error) {
        throw toCanvasError(error);
    }
}

async function closeInstance(instanceId) {
    const entry = instances.get(instanceId);
    if (!entry) {
        return;
    }

    instances.delete(instanceId);
    if (entry.udid) {
        manager.detachInstance(entry.udid, instanceId);
    }
    await entry.server.close();
}

function deviceInstanceId(udid) {
    return `ios-simulator-${udid.toLowerCase()}`;
}

function openCanvases() {
    const snapshot = copilotSession?.openCanvases;
    return Array.isArray(snapshot) ? snapshot : [];
}

function openCanvasInputMatchesUdid(canvasInstance, udid) {
    return canvasInstance?.canvasId === "ios-simulator" && canvasInstance.input?.udid === udid;
}

async function openDeviceCanvas({ udid, instanceId = deviceInstanceId(udid) }) {
    await manager.assertDeviceAvailable(udid);
    manager.assertNoActiveLease(udid);
    const canvasRpc = copilotSession?.rpc?.canvas;
    if (!canvasRpc?.open) {
        throw new AppError("canvas_open_unavailable", "This Copilot runtime does not expose session canvas opening.", 501);
    }

    const existing = openCanvases().find((canvasInstance) => openCanvasInputMatchesUdid(canvasInstance, udid));
    const targetInstanceId = existing?.instanceId ?? instanceId;
    const openInput = {
        canvasId: "ios-simulator",
        instanceId: targetInstanceId,
        input: {
            udid,
            autoBoot: false,
            bootAfterOpen: true,
        },
    };

    if (!existing) {
        queueMicrotask(() => {
            void canvasRpc.open(openInput).catch((error) => {
                void copilotSession.log(`Failed to open iOS Simulator canvas: ${error.message ?? String(error)}`);
            });
        });
        return {
            udid,
            instanceId: targetInstanceId,
            focusedExisting: false,
            opening: true,
        };
    }

    const opened = await canvasRpc.open(openInput);

    return {
        udid,
        instanceId: opened.instanceId,
        focusedExisting: Boolean(existing),
    };
}

async function switchDeviceCanvas({ instanceId, fromUdid, toUdid }) {
    const target = await manager.assertDeviceAvailable(toUdid);
    if (fromUdid) {
        manager.assertNoActiveLease(fromUdid);
    }
    manager.assertNoActiveLease(toUdid);
    const needsBoot = target.state !== "Booted";
    if (needsBoot) {
        manager.prepareBoot(toUdid);
    }

    const entry = instances.get(instanceId);
    if (!entry) {
        throw new AppError("canvas_instance_missing", "The simulator canvas is no longer available.", 404);
    }

    await canvasBindings?.set(instanceId, toUdid);
    if (fromUdid) {
        manager.detachInstance(fromUdid, instanceId);
    }
    manager.attachInstance(toUdid, instanceId);
    await entry.server.rebindDevice(toUdid);
    entry.udid = toUdid;

    if (needsBoot) {
        queueMicrotask(() => {
            void manager.completePreparedBoot(toUdid).catch((error) => {
                void copilotSession.log(`Failed to boot switched iOS Simulator device: ${error.message ?? String(error)}`);
            });
        });
    }

    return {
        udid: toUdid,
        switching: fromUdid !== toUdid,
        opening: false,
        state: needsBoot ? "Booting" : "Booted",
    };
}

function ensureString(value, fallback = "") {
    return typeof value === "string" ? value : fallback;
}

function shortUdid(udid) {
    return udid.length > 8 ? udid.slice(0, 8) : udid;
}

function canvasTitleForDevice(device, udid) {
    return device?.name || `iOS Simulator ${shortUdid(udid)}`;
}

function leasedAction({ name, description, inputSchema, operation, run }) {
    return {
        name,
        description,
        inputSchema,
        handler: async (ctx) =>
            withCanvasError(async () => {
                const operationLabel = typeof operation === "function" ? operation(ctx) : operation;
                return await manager.withLeaseOperation(
                    {
                        udid: ctx.input.udid,
                        leaseId: ctx.input.leaseId,
                        operation: operationLabel,
                    },
                    async () => run(ctx),
                );
            }),
    };
}

const leasedActions = [
    {
        name: "set_keyboard_mode",
        description: "Set simulator keyboard behavior to hardware or software keyboard.",
        inputSchema: actionSchemas.setKeyboardMode,
        operation: (ctx) => `Switching to ${ctx.input.mode} keyboard`,
        run: (ctx) => manager.setKeyboardMode(ctx.input.udid, ctx.input.mode),
    },
    {
        name: "capture_screen",
        description: "Capture a PNG screenshot and return artifact metadata and file path.",
        inputSchema: actionSchemas.captureScreen,
        operation: "Capturing screen",
        run: (ctx) => manager.captureScreen(ctx.input.udid),
    },
    {
        name: "start_video_recording",
        description: "Start a lease-bound H.264 simulator recording and return immediately so inputs can continue.",
        inputSchema: actionSchemas.startVideoRecording,
        operation: "Starting video recording",
        run: (ctx) =>
            manager.startVideoRecording({
                ...ctx.input,
                maxDurationSeconds: ctx.input.maxDurationSeconds ?? 120,
            }),
    },
    {
        name: "boot_device",
        description: "Boot a simulator device and wait until it is ready.",
        inputSchema: actionSchemas.bootDevice,
        operation: "Booting simulator",
        run: (ctx) => manager.bootDevice(ctx.input.udid),
    },
    {
        name: "shutdown_device",
        description: "Shut down a simulator device.",
        inputSchema: actionSchemas.shutdownDevice,
        operation: "Shutting down simulator",
        run: (ctx) => manager.shutdownDevice(ctx.input.udid),
    },
    {
        name: "restart_device",
        description: "Restart a simulator device by shutting it down and booting again.",
        inputSchema: actionSchemas.restartDevice,
        operation: "Restarting simulator",
        run: (ctx) => manager.restartDevice(ctx.input.udid),
    },
    {
        name: "rotate_device",
        description: "Rotate simulator orientation left or right.",
        inputSchema: actionSchemas.rotateDevice,
        operation: (ctx) => `Rotating ${ctx.input.direction}`,
        run: (ctx) => manager.rotateDevice(ctx.input.udid, ctx.input.direction),
    },
    {
        name: "press_button",
        description: "Send a hardware button action to the simulator.",
        inputSchema: actionSchemas.pressButton,
        operation: (ctx) => `Pressing ${ctx.input.button}`,
        run: (ctx) => manager.pressButton(ctx.input.udid, ctx.input.button),
    },
    {
        name: "tap",
        description: "Send a tap to the simulator at normalized or point coordinates.",
        inputSchema: actionSchemas.tap,
        operation: "Sending tap",
        run: (ctx) => manager.tap(ctx.input),
    },
    {
        name: "swipe",
        description: "Send a swipe gesture to the simulator.",
        inputSchema: actionSchemas.swipe,
        operation: "Sending swipe",
        run: (ctx) => manager.swipe(ctx.input),
    },
    {
        name: "send_key",
        description: "Send a keyboard key event to the simulator.",
        inputSchema: actionSchemas.sendKey,
        operation: (ctx) => `Sending key ${ctx.input.code}`,
        run: (ctx) => manager.sendKey(ctx.input),
    },
    {
        name: "send_text",
        description: "Send text input to the simulator.",
        inputSchema: actionSchemas.sendText,
        operation: "Sending text",
        run: (ctx) => manager.sendText(ctx.input),
    },
    {
        name: "perform_inputs",
        description: "Execute an ordered input sequence under a single lease.",
        inputSchema: actionSchemas.performInputs,
        operation: "Running input sequence",
        run: (ctx) => manager.performInputs(ctx.input),
    },
].map(leasedAction);

const canvas = createCanvas({
    id: "ios-simulator",
    displayName: "iOS Simulator",
    description: "Embedded iOS simulator canvas with lifecycle, screenshots, and agent-control leasing.",
    inputSchema: openInputSchema,
    actions: [
        {
            name: "diagnose_native_backend",
            description: "Build and validate the Swift native bridge against the selected Xcode private simulator frameworks.",
            handler: async () =>
                withCanvasError(async () => {
                    return await manager.diagnoseNativeBackend();
                }),
        },
        {
            name: "list_devices",
            description: "List available simulator devices and current runtime state.",
            handler: async () =>
                withCanvasError(async () => {
                    const devices = await manager.listDevices();
                    return { devices };
                }),
        },
        {
            name: "get_device_state",
            description: "Get current state, lease, and metadata for one simulator device.",
            inputSchema: actionSchemas.getDeviceState,
            handler: async (ctx) =>
                withCanvasError(async () => {
                    return await manager.getDeviceState(ctx.input.udid);
                }),
        },
        {
            name: "acquire_control",
            description: "Acquire an exclusive lease for a simulator so the agent can drive it safely.",
            inputSchema: actionSchemas.acquireControl,
            handler: async (ctx) =>
                withCanvasError(async () => {
                    return await manager.acquireLease({
                        udid: ctx.input.udid,
                        reason: ensureString(ctx.input.reason, "Agent sequence"),
                        ownerInstanceId: ctx.instanceId,
                        ttlSeconds: ctx.input.ttlSeconds,
                    });
                }),
        },
        {
            name: "renew_control",
            description: "Renew an existing simulator control lease before it expires.",
            inputSchema: actionSchemas.renewControl,
            handler: async (ctx) =>
                withCanvasError(async () => {
                    return await manager.renewLease({
                        udid: ctx.input.udid,
                        leaseId: ctx.input.leaseId,
                        ttlSeconds: ctx.input.ttlSeconds,
                    });
                }),
        },
        {
            name: "release_control",
            description: "Release an active simulator control lease.",
            inputSchema: actionSchemas.releaseControl,
            handler: async (ctx) =>
                withCanvasError(async () => {
                    return await manager.releaseLease({
                        udid: ctx.input.udid,
                        leaseId: ctx.input.leaseId,
                        reason: ensureString(ctx.input.reason, "Released by agent"),
                    });
                }),
        },
        {
            name: "stop_video_recording",
            description: "Stop an active recording or retrieve one finalized automatically for the supplied lease.",
            inputSchema: actionSchemas.stopVideoRecording,
            handler: async (ctx) =>
                withCanvasError(async () => {
                    return await manager.stopVideoRecording(ctx.input);
                }),
        },
        ...leasedActions,
    ],
    open: async (ctx) =>
        withCanvasError(async () => {
            const existing = instances.get(ctx.instanceId);
            const savedUdid = existing ? undefined : await canvasBindings?.get(ctx.instanceId);
            const preferredUdid = savedUdid !== undefined ? savedUdid : (ctx.input?.udid ?? null);
            const udid = preferredUdid ? await manager.resolveDeviceUdid(preferredUdid) : null;
            const autoBoot = Boolean(udid) && ctx.input?.autoBoot !== false && ctx.input?.bootAfterOpen !== true;

            if (existing && existing.udid !== udid) {
                await closeInstance(ctx.instanceId);
            }

            let entry = instances.get(ctx.instanceId);
            if (!entry) {
                const server = await createCanvasServer({
                    manager,
                    instanceId: ctx.instanceId,
                    udid,
                    webRoot,
                    openDeviceCanvas,
                    switchDeviceCanvas,
                    bootAfterOpen: ctx.input?.bootAfterOpen === true,
                });
                if (udid) {
                    manager.attachInstance(udid, ctx.instanceId);
                }
                entry = { udid, server };
                instances.set(ctx.instanceId, entry);
            }
            await canvasBindings?.set(ctx.instanceId, udid);
            if (autoBoot) {
                await manager.ensureBooted(udid);
            }

            const device = udid ? manager.getCachedDeviceState(udid) : null;
            return {
                title: udid ? canvasTitleForDevice(device, udid) : "iOS Simulator",
                status: udid ? "Ready" : "Choose a simulator",
                url: entry.server.url,
            };
        }),
    onClose: async (ctx) => {
        await closeInstance(ctx.instanceId);
        await canvasBindings?.delete(ctx.instanceId);
    },
});

let copilotSession;
copilotSession = await joinSession({
    canvases: [canvas],
});

const workspacePath = copilotSession.workspacePath;
if (workspacePath) {
    const extensionFilesRoot = path.join(workspacePath, "files", "ios-simulator");
    canvasBindings = new CanvasBindingStore(path.join(extensionFilesRoot, "canvas-bindings"));
    manager.setArtifactsRoot(extensionFilesRoot);
}
await copilotSession.log("iOS Simulator extension loaded.");

copilotSession.on("session.shutdown", async () => {
    const closes = Array.from(instances.keys()).map((instanceId) => closeInstance(instanceId));
    await Promise.allSettled(closes);
    await manager.dispose();
});
