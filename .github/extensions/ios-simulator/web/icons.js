const icons = {
    shutdown: [
        ["path", { d: "M12 2v10" }],
        ["path", { d: "M18.4 6.6a9 9 0 1 1-12.8 0" }],
    ],
    home: [
        ["path", { d: "m3 10 9-7 9 7" }],
        ["path", { d: "M5 10v10h14V10" }],
        ["path", { d: "M9 20v-6h6v6" }],
    ],
    rotateRight: [
        ["path", { d: "M12 5H6a2 2 0 0 0-2 2v3" }],
        ["path", { d: "m9 8 3-3-3-3" }],
        ["path", { d: "M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" }],
    ],
    keyboard: [
        ["path", { d: "M4 7h16a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z" }],
        ["path", { d: "M6 11h.01" }],
        ["path", { d: "M10 11h.01" }],
        ["path", { d: "M14 11h.01" }],
        ["path", { d: "M18 11h.01" }],
        ["path", { d: "M7 15h10" }],
    ],
    newTab: [
        ["path", { d: "M15 3h6v6" }],
        ["path", { d: "M10 14 21 3" }],
        ["path", { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" }],
    ],
};

export function renderIcon(name) {
    const icon = icons[name];
    if (!icon) {
        return "";
    }

    const children = icon
        .map(([tag, attrs]) => {
            const serialized = Object.entries(attrs)
                .map(([key, value]) => `${key}="${value}"`)
                .join(" ");
            return `<${tag} ${serialized}></${tag}>`;
        })
        .join("");

    return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${children}</svg>`;
}
