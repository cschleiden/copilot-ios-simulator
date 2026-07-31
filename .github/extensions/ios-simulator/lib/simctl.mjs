import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { AppError } from "./errors.mjs";

const execFileAsync = promisify(execFile);

async function runXcrun(args, options = {}) {
    const merged = {
        timeout: 180_000,
        maxBuffer: 64 * 1024 * 1024,
        encoding: "utf8",
        ...options,
    };

    try {
        return await execFileAsync("xcrun", args, merged);
    } catch (error) {
        const stderr = error?.stderr ? String(error.stderr) : "";
        const message = stderr.trim() || error?.message || "xcrun command failed";
        throw new AppError("simctl_error", message, 500);
    }
}

function flattenDevices(devicesByRuntime) {
    const flattened = [];
    for (const [runtime, devices] of Object.entries(devicesByRuntime ?? {})) {
        for (const device of devices ?? []) {
            flattened.push({
                runtime,
                udid: device.udid,
                name: device.name,
                state: device.state,
                isAvailable: device.isAvailable !== false,
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

export async function listSimulators() {
    const { stdout } = await runXcrun(["simctl", "list", "devices", "--json"]);
    let parsed;
    try {
        parsed = JSON.parse(stdout);
    } catch (error) {
        throw new AppError("simctl_parse_error", "Failed to parse simctl device list JSON.", 500);
    }
    return flattenDevices(parsed.devices);
}

export async function bootSimulator(udid) {
    try {
        await runXcrun(["simctl", "boot", udid]);
    } catch (error) {
        if (!(error instanceof AppError)) {
            throw error;
        }
        const alreadyBooted = error.message.includes("current state: Booted");
        if (!alreadyBooted) {
            throw error;
        }
    }

    await runXcrun(["simctl", "bootstatus", udid, "-b"], { timeout: 240_000 });
}

export async function shutdownSimulator(udid) {
    try {
        await runXcrun(["simctl", "shutdown", udid]);
    } catch (error) {
        if (!(error instanceof AppError)) {
            throw error;
        }
        const alreadyShutdown =
            error.message.includes("Unable to shutdown device in current state: Shutdown") ||
            error.message.includes("already shutdown");
        if (!alreadyShutdown) {
            throw error;
        }
    }
}

export async function screenshotPngBuffer(udid) {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "simctl-shot-"));
    const outputPath = path.join(tempDir, "capture.png");

    try {
        await runXcrun(["simctl", "io", udid, "screenshot", "--type=png", outputPath], {
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
        });
        const data = await readFile(outputPath);
        if (!data || data.length === 0) {
            throw new AppError("screenshot_failed", "Simulator screenshot returned empty image data.", 502);
        }
        return data;
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
}

export function parsePngDimensions(buffer) {
    const pngHeader = "89504e470d0a1a0a";
    if (!buffer || buffer.length < 24) {
        throw new AppError("png_parse_error", "Screenshot PNG is too small to parse dimensions.", 500);
    }

    const header = buffer.subarray(0, 8).toString("hex");
    if (header !== pngHeader) {
        throw new AppError("png_parse_error", "Screenshot payload is not a PNG image.", 500);
    }

    return {
        width: buffer.readUInt32BE(16),
        height: buffer.readUInt32BE(20),
    };
}
