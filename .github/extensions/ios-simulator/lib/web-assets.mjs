import { readFile } from "node:fs/promises";

const ASSETS = [
    ["/", "index.html", "text/html; charset=utf-8"],
    ["/app.js", "app.js", "application/javascript; charset=utf-8"],
    ["/api-client.js", "api-client.js", "application/javascript; charset=utf-8"],
    ["/device-picker.js", "device-picker.js", "application/javascript; charset=utf-8"],
    ["/h264-stream.js", "h264-stream.js", "application/javascript; charset=utf-8"],
    ["/input-controller.js", "input-controller.js", "application/javascript; charset=utf-8"],
    ["/icons.js", "icons.js", "application/javascript; charset=utf-8"],
    ["/device-frame.js", "device-frame.js", "application/javascript; charset=utf-8"],
    ["/styles.css", "styles.css", "text/css; charset=utf-8"],
];

export async function loadWebAssets(webRoot) {
    const loaded = new Map();
    await Promise.all(
        ASSETS.map(async ([route, filename, contentType]) => {
            loaded.set(route, {
                content: await readFile(`${webRoot}/${filename}`, "utf8"),
                contentType,
            });
        }),
    );
    return loaded;
}

export function serveWebAsset(assets, route, res) {
    const asset = assets.get(route);
    if (!asset) {
        return false;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", asset.contentType);
    res.end(asset.content);
    return true;
}
