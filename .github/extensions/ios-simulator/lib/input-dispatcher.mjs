import { AppError } from "./errors.mjs";

export class InputDispatcher {
    constructor({ state, nativeBridge, ensureBooted, screenSize }) {
        this.state = state;
        this.nativeBridge = nativeBridge;
        this.ensureBooted = ensureBooted;
        this.screenSize = screenSize;
    }

    async inputGeometry(input) {
        const screen = this.state.getDeviceOrThrow(input.udid).screen;
        if (screen?.width && screen?.height) {
            return { width: screen.width, height: screen.height };
        }
        return await this.screenSize(input.udid);
    }

    async ensureInputReady(udid) {
        const device = this.state.getDeviceOrThrow(udid);
        if (device.state !== "Booted") {
            await this.ensureBooted(udid);
        }
    }

    async rotateDevice(input, maybeDirection) {
        const udid = typeof input === "string" ? input : input?.udid;
        const direction = maybeDirection ?? input?.direction;
        const orientation = this.nextOrientation(udid, direction);
        await this.ensureInputReady(udid);
        await this.nativeBridge.send("setOrientation", { udid, orientation });
        return this.state.setOrientation(udid, orientation);
    }

    async goHome(input) {
        const udid = typeof input === "string" ? input : input?.udid;
        await this.ensureInputReady(udid);
        return await this.nativeBridge.send("pressButton", { udid, button: "home" });
    }

    async pressButton(input, maybeButton) {
        const udid = typeof input === "string" ? input : input?.udid;
        const button = maybeButton ?? input?.button;
        await this.ensureInputReady(udid);
        return await this.nativeBridge.send("pressButton", { udid, button });
    }

    async tap(input) {
        await this.ensureInputReady(input.udid);
        const coordinateSpace = input.coordinateSpace ?? "normalized";
        const size = await this.inputGeometry(input);
        return await this.nativeBridge.send("tap", {
            udid: input.udid,
            x: input.x,
            y: input.y,
            coordinateSpace,
            width: size.width,
            height: size.height,
            durationMs: input.durationMs,
        });
    }

    async swipe(input) {
        await this.ensureInputReady(input.udid);
        const coordinateSpace = input.coordinateSpace ?? "normalized";
        const size = await this.inputGeometry(input);
        return await this.nativeBridge.send("swipe", {
            udid: input.udid,
            startX: input.startX,
            startY: input.startY,
            endX: input.endX,
            endY: input.endY,
            coordinateSpace,
            width: size.width,
            height: size.height,
            durationMs: input.durationMs,
        });
    }

    async touch(input) {
        await this.ensureInputReady(input.udid);
        const size = await this.inputGeometry(input);
        return await this.nativeBridge.send("touch", {
            udid: input.udid,
            phase: input.phase,
            x: input.x,
            y: input.y,
            coordinateSpace: input.coordinateSpace,
            width: size.width,
            height: size.height,
        });
    }

    async prepareTouchStream(udid) {
        await this.ensureInputReady(udid);
        await this.nativeBridge.start();
        return { udid, ready: true };
    }

    async notifyTouch(input) {
        if (!["down", "move", "up", "cancel"].includes(input.phase)) {
            throw new AppError("invalid_touch_phase", `Unsupported touch phase: ${input.phase}`, 400);
        }
        if (
            typeof input.x !== "number" ||
            typeof input.y !== "number" ||
            Number.isNaN(input.x) ||
            Number.isNaN(input.y)
        ) {
            throw new AppError("invalid_touch_coordinates", "Touch coordinates must be numeric.", 400);
        }
        if (input.coordinateSpace !== "normalized") {
            throw new AppError("invalid_coordinate_space", "Touch streams currently require normalized coordinates.", 400);
        }
        const size = await this.inputGeometry(input);
        await this.nativeBridge.notify("touch", {
            udid: input.udid,
            phase: input.phase,
            x: input.x,
            y: input.y,
            coordinateSpace: "normalized",
            width: size.width,
            height: size.height,
        });
    }

    async sendKey(input) {
        await this.ensureInputReady(input.udid);
        const phase =
            typeof input.keyDown === "boolean" ? (input.keyDown ? "down" : "up") : "press";
        return await this.nativeBridge.send("sendKey", {
            udid: input.udid,
            code: input.code,
            modifiers: input.modifiers ?? [],
            phase,
        });
    }

    async sendText(input) {
        await this.ensureInputReady(input.udid);
        return await this.nativeBridge.send("sendText", {
            udid: input.udid,
            text: input.text,
        });
    }

    async performInputs(input) {
        const handlers = {
            tap: (stepInput) => this.tap(stepInput),
            swipe: (stepInput) => this.swipe(stepInput),
            key: (stepInput) => this.sendKey(stepInput),
            text: (stepInput) => this.sendText(stepInput),
            button: (stepInput) => this.pressButton(stepInput),
            rotate: (stepInput) => this.rotateDevice(input.udid, stepInput.direction),
        };
        const results = [];
        for (const step of input.steps) {
            const handler = handlers[step.kind];
            if (!handler) {
                throw new AppError("unsupported_input_step", `Unsupported input step: ${step.kind}`, 400);
            }
            results.push(await handler({ udid: input.udid, ...step.input }));
        }
        return { udid: input.udid, results };
    }

    nextOrientation(udid, direction) {
        if (!["left", "right"].includes(direction)) {
            throw new AppError("invalid_rotation_direction", `Unsupported rotation direction: ${direction}`, 400);
        }

        const orientations = ["portrait", "landscape-left", "portrait-upside-down", "landscape-right"];
        const current = this.state.getDeviceOrThrow(udid).orientation;
        const currentIndex = Math.max(0, orientations.indexOf(current));
        const delta = direction === "left" ? 1 : -1;
        return orientations[(currentIndex + delta + orientations.length) % orientations.length];
    }
}
