import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppError } from "./errors.mjs";
import { nowIso, timestampName } from "./device-model.mjs";
import {
    parsePngDimensions,
    screenshotPngBuffer,
} from "./simctl.mjs";

export class ScreenService {
    constructor({ state, nativeBridge, artifactsRoot, ensureBooted }) {
        this.state = state;
        this.nativeBridge = nativeBridge;
        this.artifactsRoot = artifactsRoot;
        this.ensureBooted = ensureBooted;
    }

    async captureScreen(udid) {
        await this.ensureBooted(udid);
        const artifactsRoot = this.artifactsRoot();
        if (!artifactsRoot) {
            throw new AppError("artifact_root_missing", "Artifact root path is not configured.", 500);
        }

        const dir = path.join(artifactsRoot, udid);
        await mkdir(dir, { recursive: true });
        const filePath = path.join(dir, `capture-${timestampName()}.png`);
        const image = await screenshotPngBuffer(udid);
        const size = parsePngDimensions(image);
        this.state.updateScreenMetrics(udid, size, "screenshot");
        await writeFile(filePath, image);

        return {
            udid,
            artifactPath: filePath,
            pixelSize: size,
            pointSize: size,
            orientation: this.state.getDeviceOrThrow(udid).orientation,
            scale: 1,
            capturedAt: nowIso(),
        };
    }

    async getFramePng(udid) {
        await this.ensureBooted(udid);
        const image = await screenshotPngBuffer(udid);
        this.state.updateScreenMetrics(udid, parsePngDimensions(image), "screenshot");
        return image;
    }

    async refreshScreenMetrics(udid) {
        const image = await screenshotPngBuffer(udid);
        return this.state.updateScreenMetrics(udid, parsePngDimensions(image), "screenshot");
    }

    async createMjpegStream({ udid, fps, resolution }) {
        await this.ensureBooted(udid);
        if (!this.nativeBridge) {
            throw new AppError("native_bridge_unconfigured", "Native bridge path is not configured.", 500);
        }
        return await this.nativeBridge.createMjpegStream({ udid, fps, resolution });
    }

    async createH264Stream({ udid, fps, resolution }) {
        await this.ensureBooted(udid);
        if (!this.nativeBridge) {
            throw new AppError("native_bridge_unconfigured", "Native bridge path is not configured.", 500);
        }
        return await this.nativeBridge.createH264Stream({ udid, fps, resolution });
    }

    async screenSize(udid) {
        const image = await screenshotPngBuffer(udid);
        return parsePngDimensions(image);
    }
}
