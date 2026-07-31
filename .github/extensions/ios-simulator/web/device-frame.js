const fallbackScreens = {
    phone: { width: 1290, height: 2796 },
    tablet: { width: 1640, height: 2360 },
};

function normalizedFamily(family) {
    return family === "tablet" ? "tablet" : "phone";
}

function normalizedScreenMetrics(metrics, family = "phone") {
    const fallback = fallbackScreens[normalizedFamily(family)] ?? fallbackScreens.phone;
    const width = Number(metrics?.width) > 0 ? Number(metrics.width) : fallback.width;
    const height = Number(metrics?.height) > 0 ? Number(metrics.height) : fallback.height;
    return { width, height };
}

function isLandscapeOrientation(orientation) {
    return orientation === "landscape-left" || orientation === "landscape-right";
}

export function displayScreenMetrics(metrics, family = "phone", orientation = "portrait") {
    const { width, height } = normalizedScreenMetrics(metrics, family);
    const wantsLandscape = isLandscapeOrientation(orientation);
    const isLandscape = width > height;
    if (wantsLandscape !== isLandscape) {
        return { width: height, height: width };
    }
    return { width, height };
}

function frameMetrics(metrics, family = "phone", orientation = "portrait") {
    const nextFamily = normalizedFamily(family);
    const { width, height } = displayScreenMetrics(metrics, nextFamily, orientation);
    const shortSide = Math.min(width, height);
    const bezel = Math.round(shortSide * (nextFamily === "tablet" ? 0.028 : 0.038));
    const screenRadius = Math.round(shortSide * (nextFamily === "tablet" ? 0.034 : 0.13));
    const frameRadius = screenRadius + bezel;
    const frameWidth = width + bezel * 2;
    const frameHeight = height + bezel * 2;
    return {
        family: nextFamily,
        orientation: height >= width ? "portrait" : "landscape",
        bezel,
        screenRadius,
        frameRadius,
        frameWidth,
        frameHeight,
        aspect: frameWidth / frameHeight,
        sideButton: {
            width: Math.max(2, Math.round(shortSide * 0.006)),
            shortLength: Math.round(shortSide * 0.13),
            longLength: Math.round(shortSide * 0.19),
            upperOffset: Math.round(Math.max(width, height) * 0.18),
            lowerOffset: Math.round(Math.max(width, height) * 0.275),
            rightOffset: Math.round(Math.max(width, height) * 0.24),
        },
    };
}

export function applyDeviceMetrics({ viewport, phoneFrame }, metrics, family = "phone", orientation = "portrait") {
    const next = frameMetrics(metrics, family, orientation);
    phoneFrame.dataset.frameWidth = String(next.frameWidth);
    phoneFrame.dataset.frameHeight = String(next.frameHeight);
    phoneFrame.dataset.frameAspect = String(next.aspect);
    phoneFrame.dataset.sourceBezel = String(next.bezel);
    phoneFrame.dataset.sourceScreenRadius = String(next.screenRadius);
    phoneFrame.dataset.sourceFrameRadius = String(next.frameRadius);
    phoneFrame.dataset.sourceSideButtonWidth = String(next.sideButton.width);
    phoneFrame.dataset.sourceSideButtonShortLength = String(next.sideButton.shortLength);
    phoneFrame.dataset.sourceSideButtonLongLength = String(next.sideButton.longLength);
    phoneFrame.dataset.sourceSideButtonUpperOffset = String(next.sideButton.upperOffset);
    phoneFrame.dataset.sourceSideButtonLowerOffset = String(next.sideButton.lowerOffset);
    phoneFrame.dataset.sourceSideButtonRightOffset = String(next.sideButton.rightOffset);
    phoneFrame.style.setProperty("--device-frame-width", `${next.frameWidth}px`);
    phoneFrame.style.setProperty("--device-frame-height", `${next.frameHeight}px`);
    phoneFrame.style.setProperty("--device-aspect", String(next.aspect));
    phoneFrame.classList.toggle("tablet", next.family === "tablet");
    phoneFrame.classList.toggle("phone", next.family !== "tablet");
    phoneFrame.classList.toggle("landscape", next.orientation === "landscape");
    phoneFrame.classList.toggle("portrait", next.orientation !== "landscape");
    const stage = phoneFrame.closest(".device-stage");
    stage?.classList.toggle("landscape", next.orientation === "landscape");
    stage?.classList.toggle("portrait", next.orientation !== "landscape");
    fitDeviceFrame({ viewport, phoneFrame });
}

export function fitDeviceFrame({ viewport, phoneFrame }) {
    const frameWidth = Number(phoneFrame.dataset.frameWidth);
    const frameHeight = Number(phoneFrame.dataset.frameHeight);
    const aspect = Number(phoneFrame.dataset.frameAspect);
    if (!(frameWidth > 0 && frameHeight > 0 && aspect > 0)) {
        return;
    }

    const viewportRect = viewport.getBoundingClientRect();
    const styles = getComputedStyle(viewport);
    const floatingToolbar = viewport.querySelector(".floating-toolbar");
    const toolbarGap = parseFloat(styles.getPropertyValue("--floating-toolbar-gap")) || 0;
    const toolbarVisible = floatingToolbar && getComputedStyle(floatingToolbar).display !== "none";
    const toolbarRect = toolbarVisible ? floatingToolbar.getBoundingClientRect() : { width: 0, height: 0 };
    const stage = phoneFrame.closest(".device-stage");
    const isLandscape = phoneFrame.classList.contains("landscape");
    stage?.style.setProperty("--floating-toolbar-width", `${toolbarRect.width}px`);
    stage?.style.setProperty("--floating-toolbar-height", `${toolbarRect.height}px`);
    const toolbarWidth = toolbarVisible && !isLandscape ? toolbarRect.width + toolbarGap : 0;
    const toolbarHeight = toolbarVisible && isLandscape ? toolbarRect.height + toolbarGap : 0;
    const availableWidth =
        viewportRect.width - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight);
    const availableHeight =
        viewportRect.height - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom);
    const frameAvailableWidth = availableWidth - toolbarWidth;
    const frameAvailableHeight = availableHeight - toolbarHeight;
    if (frameAvailableWidth < 80 || frameAvailableHeight < 120) {
        return;
    }

    let fittedWidth = Math.min(frameWidth, frameAvailableWidth, frameAvailableHeight * aspect);
    let fittedHeight = fittedWidth / aspect;
    if (fittedHeight > frameAvailableHeight) {
        fittedHeight = Math.min(frameHeight, frameAvailableHeight);
        fittedWidth = fittedHeight * aspect;
    }
    phoneFrame.style.width = `${fittedWidth}px`;
    phoneFrame.style.height = `${fittedHeight}px`;

    const scale = fittedWidth / frameWidth;
    setScaledProperty(phoneFrame, "--bezel", phoneFrame.dataset.sourceBezel, scale);
    setScaledProperty(phoneFrame, "--screen-radius", phoneFrame.dataset.sourceScreenRadius, scale);
    setScaledProperty(phoneFrame, "--frame-radius", phoneFrame.dataset.sourceFrameRadius, scale);
    setScaledProperty(phoneFrame, "--side-button-width", phoneFrame.dataset.sourceSideButtonWidth, scale);
    setScaledProperty(phoneFrame, "--side-button-short", phoneFrame.dataset.sourceSideButtonShortLength, scale);
    setScaledProperty(phoneFrame, "--side-button-long", phoneFrame.dataset.sourceSideButtonLongLength, scale);
    setScaledProperty(phoneFrame, "--side-button-upper", phoneFrame.dataset.sourceSideButtonUpperOffset, scale);
    setScaledProperty(phoneFrame, "--side-button-lower", phoneFrame.dataset.sourceSideButtonLowerOffset, scale);
    setScaledProperty(phoneFrame, "--side-button-right", phoneFrame.dataset.sourceSideButtonRightOffset, scale);
}

function setScaledProperty(element, property, sourceValue, scale) {
    const value = Number(sourceValue);
    if (value > 0 && scale > 0) {
        element.style.setProperty(property, `${Math.max(1, value * scale)}px`);
    }
}
