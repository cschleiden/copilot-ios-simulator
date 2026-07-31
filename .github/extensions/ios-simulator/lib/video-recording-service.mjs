import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "./errors.mjs";
import { nowIso, timestampName } from "./device-model.mjs";

const RECORDING_START_TIMEOUT_MS = 15_000;
const RECORDING_STOP_TIMEOUT_MS = 15_000;
const COMPLETED_RECORDING_LIMIT = 32;
const COMPLETED_RECORDING_TTL_MS = 15 * 60_000;

export class VideoRecordingService {
    constructor({ state, artifactsRoot, ensureBooted }) {
        this.state = state;
        this.artifactsRoot = artifactsRoot;
        this.ensureBooted = ensureBooted;
        this.active = new Map();
        this.completed = new Map();
    }

    async start({ udid, leaseId, maxDurationSeconds }) {
        if (this.active.has(udid)) {
            throw new AppError("recording_active", "A video recording is already active for this simulator.", 409);
        }

        const recordingId = randomUUID();
        const recording = {
            recordingId,
            udid,
            leaseId,
            artifactPath: null,
            startedAt: null,
            maxDurationSeconds,
            child: null,
            stderr: "",
            stopPromise: null,
            timeout: null,
            unsubscribe: null,
            cleanupError: null,
            cancelled: false,
        };
        this.active.set(udid, recording);

        try {
            await this.ensureBooted(udid);
            const artifactsRoot = this.artifactsRoot();
            if (!artifactsRoot) {
                throw new AppError("artifact_root_missing", "Artifact root path is not configured.", 500);
            }

            const dir = path.join(artifactsRoot, udid);
            await mkdir(dir, { recursive: true });
            if (recording.cancelled) {
                throw new AppError("recording_cancelled", "Video recording was cancelled before it started.", 409);
            }
            this.state.assertLease({ udid, leaseId });

            recording.artifactPath = path.join(dir, `recording-${timestampName()}.mov`);
            recording.startedAt = nowIso();
            recording.child = spawn(
                "xcrun",
                ["simctl", "io", udid, "recordVideo", "--codec=h264", "--force", recording.artifactPath],
                { stdio: ["ignore", "ignore", "pipe"] },
            );
            recording.child.stderr.on("data", (chunk) => {
                recording.stderr = `${recording.stderr}${chunk}`.slice(-16_384);
            });
            recording.unsubscribe = this.state.subscribe(udid, (snapshot) => {
                if (!snapshot.lease?.active || snapshot.lease.leaseId !== leaseId) {
                    void this.finish(recording, "lease-ended").catch((error) => {
                        recording.cleanupError = error;
                    });
                }
            });
            this.state.assertLease({ udid, leaseId });

            await this.waitUntilStarted(recording);

            recording.timeout = setTimeout(() => {
                void this.finish(recording, "timeout").catch((error) => {
                    recording.cleanupError = error;
                });
            }, maxDurationSeconds * 1000);

            return this.activeMetadata(recording);
        } catch (error) {
            if (recording.child) {
                try {
                    await this.finish(recording, "start-failed");
                } catch (cleanupError) {
                    error.cause = cleanupError;
                }
            } else if (this.active.get(udid) === recording) {
                this.active.delete(udid);
            }
            throw error;
        }
    }

    async stop({ udid, leaseId, recordingId }) {
        const active = this.active.get(udid);
        if (active && active.leaseId === leaseId && active.recordingId === recordingId) {
            return await this.finish(active, "requested");
        }

        this.pruneCompleted();
        const completed = this.completed.get(recordingId);
        if (!completed || completed.udid !== udid || completed.leaseId !== leaseId) {
            throw new AppError("recording_not_found", "Video recording not found or already finalized.", 404);
        }
        this.completed.delete(recordingId);
        return completed.metadata;
    }

    async stopAll() {
        const stops = Array.from(this.active.values(), (recording) => {
            if (!recording.child) {
                recording.cancelled = true;
                if (this.active.get(recording.udid) === recording) {
                    this.active.delete(recording.udid);
                }
                return Promise.resolve();
            }
            return this.finish(recording, "shutdown");
        });
        await Promise.allSettled(stops);
        this.completed.clear();
    }

    activeMetadata(recording) {
        return {
            recordingId: recording.recordingId,
            udid: recording.udid,
            artifactPath: recording.artifactPath,
            codec: "h264",
            container: "quicktime",
            startedAt: recording.startedAt,
            maxDurationSeconds: recording.maxDurationSeconds,
            recording: true,
        };
    }

    assertRecording(recording, leaseId, recordingId) {
        if (recording.leaseId !== leaseId || recording.recordingId !== recordingId) {
            throw new AppError("recording_not_found", "Video recording does not belong to this control lease.", 404);
        }
    }

    waitUntilStarted(recording) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
                clearTimeout(timeout);
                recording.child.stderr.off("data", onData);
                recording.child.off("error", onError);
                recording.child.off("exit", onExit);
            };
            const succeed = () => {
                if (!settled) {
                    settled = true;
                    cleanup();
                    resolve();
                }
            };
            const fail = (error) => {
                if (!settled) {
                    settled = true;
                    cleanup();
                    reject(error);
                }
            };
            const onData = () => {
                if (recording.stderr.includes("Recording started")) {
                    succeed();
                }
            };
            const onError = (error) => {
                fail(new AppError("recording_start_failed", error.message, 502));
            };
            const onExit = (code, signal) => {
                fail(
                    new AppError(
                        "recording_start_failed",
                        recording.stderr.trim() || `Video recorder exited before starting (${signal ?? code ?? "unknown"}).`,
                        502,
                    ),
                );
            };
            const timeout = setTimeout(() => {
                fail(new AppError("recording_start_timeout", "Timed out waiting for video recording to start.", 504));
            }, RECORDING_START_TIMEOUT_MS);
            recording.child.stderr.on("data", onData);
            recording.child.once("error", onError);
            recording.child.once("exit", onExit);
        });
    }

    finish(recording, reason) {
        if (recording.stopPromise) {
            return recording.stopPromise;
        }
        recording.stopPromise = this.finalize(recording, reason);
        return recording.stopPromise;
    }

    async finalize(recording, reason) {
        if (!recording.child) {
            throw new AppError("recording_not_started", "Video recording has not started yet.", 409);
        }
        clearTimeout(recording.timeout);
        recording.unsubscribe?.();
        if (recording.child.exitCode === null && recording.child.signalCode === null) {
            recording.child.kill("SIGINT");
        }

        let exit;
        try {
            exit = await this.waitForExit(recording);
        } finally {
            if (this.active.get(recording.udid) === recording) {
                this.active.delete(recording.udid);
            }
        }
        const file = await stat(recording.artifactPath).catch((error) => {
            throw new AppError(
                "recording_finalize_failed",
                recording.stderr.trim() || error.message || "Video recording was not finalized.",
                502,
            );
        });
        if (file.size === 0) {
            throw new AppError("recording_finalize_failed", "Video recording produced an empty file.", 502);
        }
        if (exit.code !== 0 && exit.signal !== "SIGINT") {
            throw new AppError(
                "recording_finalize_failed",
                recording.stderr.trim() || `Video recorder exited with code ${exit.code}.`,
                502,
            );
        }

        const stoppedAt = nowIso();
        const metadata = {
            recordingId: recording.recordingId,
            udid: recording.udid,
            artifactPath: recording.artifactPath,
            codec: "h264",
            container: "quicktime",
            byteSize: file.size,
            startedAt: recording.startedAt,
            stoppedAt,
            durationMs: new Date(stoppedAt).getTime() - new Date(recording.startedAt).getTime(),
            stopReason: reason,
            recording: false,
        };
        if (reason === "lease-ended" || reason === "timeout") {
            this.rememberCompleted(recording, metadata);
        }
        return metadata;
    }

    rememberCompleted(recording, metadata) {
        this.pruneCompleted();
        this.completed.set(recording.recordingId, {
            udid: recording.udid,
            leaseId: recording.leaseId,
            metadata,
            expiresAt: Date.now() + COMPLETED_RECORDING_TTL_MS,
        });
        while (this.completed.size > COMPLETED_RECORDING_LIMIT) {
            this.completed.delete(this.completed.keys().next().value);
        }
    }

    pruneCompleted() {
        const now = Date.now();
        for (const [recordingId, completed] of this.completed) {
            if (completed.expiresAt <= now) {
                this.completed.delete(recordingId);
            }
        }
    }

    waitForExit(recording) {
        if (recording.child.exitCode !== null || recording.child.signalCode !== null) {
            return Promise.resolve({ code: recording.child.exitCode, signal: recording.child.signalCode });
        }
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                recording.child.kill("SIGTERM");
                reject(new AppError("recording_stop_timeout", "Timed out finalizing video recording.", 504));
            }, RECORDING_STOP_TIMEOUT_MS);
            recording.child.once("exit", (code, signal) => {
                clearTimeout(timeout);
                resolve({ code, signal });
            });
            recording.child.once("error", (error) => {
                clearTimeout(timeout);
                reject(new AppError("recording_finalize_failed", error.message, 502));
            });
        });
    }
}
