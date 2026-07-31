import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export class CanvasBindingStore {
    constructor(root) {
        this.root = root;
    }

    filePath(instanceId) {
        return path.join(this.root, `${instanceId}.json`);
    }

    async get(instanceId) {
        try {
            const payload = JSON.parse(await readFile(this.filePath(instanceId), "utf8"));
            return typeof payload.udid === "string" || payload.udid === null ? payload.udid : undefined;
        } catch (error) {
            if (error?.code === "ENOENT") {
                return undefined;
            }
            throw error;
        }
    }

    async set(instanceId, udid) {
        await mkdir(this.root, { recursive: true });
        await writeFile(this.filePath(instanceId), `${JSON.stringify({ udid })}\n`, "utf8");
    }

    async delete(instanceId) {
        try {
            await unlink(this.filePath(instanceId));
        } catch (error) {
            if (error?.code !== "ENOENT") {
                throw error;
            }
        }
    }
}
