export function createApiClient(location) {
    const basePath = new URL(".", location).pathname;
    const baseUrl = `${new URL(location).origin}${basePath}`;

    function url(relativePath) {
        return new URL(relativePath, baseUrl);
    }

    async function fetchJson(relativePath, body = null) {
        const response = await fetch(url(relativePath), {
            method: body ? "POST" : "GET",
            headers: body ? { "Content-Type": "application/json" } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const message = payload?.error?.message ?? `Request failed (${response.status})`;
            throw new Error(message);
        }
        return payload;
    }

    return { fetchJson, url };
}
