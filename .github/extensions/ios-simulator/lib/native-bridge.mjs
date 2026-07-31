import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { AppError } from "./errors.mjs";

export class NativeBridge {
    constructor({ nativeRoot }) {
        this.nativeRoot = nativeRoot;
        this.executablePath = path.join(nativeRoot, ".build", "debug", "SimulatorBridge");
        this.child = null;
        this.nextId = 1;
        this.pending = new Map();
        this.stdoutBuffer = "";
        this.stderrBuffer = "";
        this.startPromise = null;
    }

    async ensureBuilt() {
        const child = spawn("swift", ["build", "--package-path", this.nativeRoot], {
            stdio: ["ignore", "pipe", "pipe"],
        });

        const stderrChunks = [];
        child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
        const [code] = await once(child, "close");
        if (code !== 0) {
            const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
            throw new AppError("native_build_failed", stderr || `swift build exited with code ${code}`, 500);
        }
    }

    async start() {
        if (this.child && !this.child.killed) {
            return;
        }
        if (this.startPromise) {
            await this.startPromise;
            return;
        }

        this.startPromise = this.startProcess();
        try {
            await this.startPromise;
        } finally {
            this.startPromise = null;
        }
    }

    async startProcess() {
        await this.ensureBuilt();
        const child = spawn(this.executablePath, [], {
            cwd: this.nativeRoot,
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.child = child;
        this.stdoutBuffer = "";
        this.stderrBuffer = "";

        child.stdout.on("data", (chunk) => this.handleStdout(chunk));
        child.stderr.on("data", (chunk) => {
            this.stderrBuffer += chunk.toString("utf8");
            if (this.stderrBuffer.length > 16_384) {
                this.stderrBuffer = this.stderrBuffer.slice(-16_384);
            }
        });
        child.on("exit", (code, signal) => {
            const pending = Array.from(this.pending.values());
            this.pending.clear();
            this.child = null;
            for (const entry of pending) {
                entry.reject(
                    new AppError(
                        "native_bridge_exited",
                        `Native bridge exited unexpectedly (${signal ?? code ?? "unknown"}).`,
                        502,
                    ),
                );
            }
        });
    }

    handleStdout(chunk) {
        this.stdoutBuffer += chunk.toString("utf8");
        while (true) {
            const newline = this.stdoutBuffer.indexOf("\n");
            if (newline === -1) {
                break;
            }
            const line = this.stdoutBuffer.slice(0, newline).trim();
            this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
            if (line.length > 0) {
                this.handleLine(line);
            }
        }
    }

    handleLine(line) {
        let payload;
        try {
            payload = JSON.parse(line);
        } catch {
            throw new AppError("native_protocol_invalid", `Native bridge emitted invalid JSON: ${line}`, 502);
        }

        const entry = this.pending.get(payload.id);
        if (!entry) {
            return;
        }
        this.pending.delete(payload.id);

        if (payload.ok) {
            entry.resolve(payload.result);
        } else {
            entry.reject(
                new AppError(
                    payload.error?.code ?? "native_bridge_error",
                    payload.error?.message ?? "Native bridge command failed.",
                    502,
                    payload.error,
                ),
            );
        }
    }

    async send(method, params = {}) {
        await this.start();
        const id = `native-${this.nextId++}`;
        const payload = `${JSON.stringify({ id, method, params })}\n`;

        return await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(new AppError("native_bridge_timeout", `Native bridge command timed out: ${method}`, 504));
            }, 240_000);

            this.pending.set(id, {
                resolve: (value) => {
                    clearTimeout(timeout);
                    resolve(value);
                },
                reject: (error) => {
                    clearTimeout(timeout);
                    reject(error);
                },
            });

            this.child.stdin.write(payload, "utf8", (error) => {
                if (error) {
                    clearTimeout(timeout);
                    this.pending.delete(id);
                    reject(new AppError("native_bridge_write_failed", error.message, 502));
                }
            });
        });
    }

    async notify(method, params = {}) {
        await this.start();
        const payload = `${JSON.stringify({ method, params })}\n`;
        await new Promise((resolve, reject) => {
            this.child.stdin.write(payload, "utf8", (error) => {
                if (error) {
                    reject(new AppError("native_bridge_write_failed", error.message, 502));
                } else {
                    resolve();
                }
            });
        });
    }

    async createMjpegStream({ udid, fps, resolution }) {
        await this.ensureBuilt();
        const normalizedFps = fps === 60 ? 60 : 30;
        const normalizedResolution = resolution === 25 || resolution === 50 ? resolution : 100;
        const child = spawn(
            this.executablePath,
            [
                "stream-mjpeg",
                "--udid",
                udid,
                "--fps",
                String(normalizedFps),
                "--resolution",
                String(normalizedResolution),
            ],
            {
                cwd: this.nativeRoot,
                stdio: ["ignore", "pipe", "pipe"],
            },
        );

        let stderr = "";
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
            if (stderr.length > 8_192) {
                stderr = stderr.slice(-8_192);
            }
        });

        child.stderrText = () => stderr.trim();
        return child;
    }

    async createH264Stream({ udid, fps, resolution }) {
        await this.ensureBuilt();
        const normalizedFps = fps === 60 ? 60 : 30;
        const normalizedResolution = resolution === 25 || resolution === 50 ? resolution : 100;
        const child = spawn(
            this.executablePath,
            [
                "stream-h264",
                "--udid",
                udid,
                "--fps",
                String(normalizedFps),
                "--resolution",
                String(normalizedResolution),
            ],
            {
                cwd: this.nativeRoot,
                stdio: ["ignore", "pipe", "pipe"],
            },
        );

        let stderr = "";
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
            if (stderr.length > 8_192) {
                stderr = stderr.slice(-8_192);
            }
        });

        child.stderrText = () => stderr.trim();
        return child;
    }

    async stop() {
        if (!this.child) {
            return;
        }

        const child = this.child;
        this.child = null;
        child.stdin.end();
        child.kill("SIGTERM");
        await Promise.race([
            once(child, "close"),
            new Promise((resolve) => setTimeout(resolve, 2_000)),
        ]);
    }
}
