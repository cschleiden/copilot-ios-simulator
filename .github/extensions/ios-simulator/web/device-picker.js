import { renderIcon } from "./icons.js";

export function createDevicePicker({
    elements,
    fetchJson,
    getState,
    isPending,
    loadState,
    reconnectStream,
    setNotice,
    withPending,
}) {
    let open = false;
    let data = null;

    function close() {
        open = false;
        elements.button.setAttribute("aria-expanded", "false");
        elements.menu.classList.add("hidden");
    }

    function position() {
        if (!open) {
            return;
        }
        const rect = elements.button.getBoundingClientRect();
        const width = Math.min(460, Math.max(340, window.innerWidth - 24));
        const left = Math.min(Math.max(12, rect.left), window.innerWidth - width - 12);
        elements.menu.style.width = `${width}px`;
        elements.menu.style.left = `${left}px`;
        elements.menu.style.top = `${rect.bottom + 8}px`;
    }

    async function refresh() {
        data = await fetchJson("api/devices");
        render();
    }

    function show() {
        open = true;
        elements.button.setAttribute("aria-expanded", "true");
        elements.menu.classList.remove("hidden");
        position();
        void refresh().catch((error) => setNotice(error.message, true));
    }

    function toggle() {
        if (open) {
            close();
        } else {
            show();
        }
    }

    function appendRow(container, device, disabled) {
        const row = document.createElement("div");
        row.className = "device-row";
        row.dataset.current = String(device.isCurrent);
        row.dataset.open = String(device.isOpen);
        row.dataset.udid = device.udid;
        row.dataset.disabled = String(disabled || device.isCurrent || device.isAvailable === false);
        row.role = "button";
        row.tabIndex = disabled || device.isCurrent || device.isAvailable === false ? -1 : 0;

        const details = document.createElement("div");
        details.className = "device-row-details";
        const nameLine = document.createElement("div");
        nameLine.className = "device-row-name";
        const name = document.createElement("span");
        name.textContent = device.name ?? device.udid;
        nameLine.append(name);
        const meta = document.createElement("div");
        meta.className = "device-row-meta";
        meta.textContent = device.runtimeLabel ?? "";
        details.append(nameLine, meta);

        const actions = document.createElement("div");
        actions.className = "device-row-actions";
        const openButton = document.createElement("button");
        openButton.className = "device-action";
        openButton.type = "button";
        openButton.dataset.deviceAction = "open";
        openButton.dataset.udid = device.udid;
        openButton.innerHTML = renderIcon("newTab");
        openButton.title = device.isCurrent ? "Already shown in this tab" : "Open this simulator in a new tab";
        openButton.setAttribute("aria-label", `Open ${device.name} in a new simulator tab`);
        openButton.disabled = disabled || device.isCurrent || device.isAvailable === false;
        actions.append(openButton);
        row.append(details, actions);
        container.append(row);
    }

    function render() {
        const state = getState();
        const disabled = isPending();
        elements.button.disabled = disabled;
        if (!data) {
            elements.content.replaceChildren();
            const loading = document.createElement("div");
            loading.className = "device-empty";
            loading.textContent = "Loading simulators…";
            elements.content.append(loading);
            return;
        }

        const fragment = document.createDocumentFragment();
        for (const [key, label] of [
            ["booted", "Booted"],
            ["available", "Available"],
        ]) {
            const devices = data.groups?.[key] ?? [];
            const section = document.createElement("section");
            section.className = "device-group";
            const heading = document.createElement("div");
            heading.className = "device-group-heading";
            heading.textContent = `${label} (${devices.length})`;
            section.append(heading);
            if (devices.length === 0) {
                const empty = document.createElement("div");
                empty.className = "device-empty";
                empty.textContent = key === "booted" ? "No devices are booted." : "No devices in this group.";
                section.append(empty);
            } else {
                for (const device of devices) {
                    appendRow(section, device, disabled);
                }
            }
            fragment.append(section);
        }
        elements.content.replaceChildren(fragment);
        elements.button.dataset.deviceState = String(state?.state ?? "unknown").toLowerCase();
        position();
    }

    function bind() {
        elements.button.addEventListener("click", (event) => {
            event.preventDefault();
            toggle();
        });
        elements.content.addEventListener("click", (event) => {
            const button = event.target.closest("[data-device-action]");
            if (button?.disabled) {
                return;
            }
            const row = event.target.closest(".device-row");
            if (!button && (!row || row.dataset.disabled === "true")) {
                return;
            }
            const state = getState();
            const udid = button?.dataset.udid ?? row.dataset.udid;
            const action =
                button?.dataset.deviceAction ??
                (state?.state === "Unassigned" || row.dataset.open !== "true" ? "switch" : "focus");
            close();
            void withPending(async () => {
                if (action === "switch") {
                    await fetchJson("api/device/switch", { udid });
                    await loadState();
                    await refresh();
                    reconnectStream();
                    return;
                }
                const result = await fetchJson("api/device/open", { udid });
                setNotice(result.focusedExisting ? "Focused existing simulator tab." : "Opened simulator in a new tab.");
                await refresh();
            }).catch((error) => setNotice(error.message, true));
        });
        elements.content.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") {
                return;
            }
            if (event.target.closest("[data-device-action]")) {
                return;
            }
            const row = event.target.closest(".device-row");
            if (!row || row.dataset.disabled === "true") {
                return;
            }
            event.preventDefault();
            row.click();
        });
        document.addEventListener("click", (event) => {
            if (open && !elements.root.contains(event.target)) {
                close();
            }
        });
        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape" && open) {
                close();
                elements.button.focus();
                event.preventDefault();
            }
        });
        window.addEventListener("resize", position);
    }

    return { bind, close, refresh, render };
}
