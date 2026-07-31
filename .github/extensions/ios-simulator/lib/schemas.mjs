const requiredUdid = {
    type: "object",
    additionalProperties: false,
    properties: {
        udid: { type: "string", minLength: 1 },
    },
    required: ["udid"],
};

const leaseFields = {
    udid: { type: "string", minLength: 1 },
    leaseId: { type: "string", minLength: 1 },
};

const coordinateSpace = {
    type: "string",
    enum: ["points", "normalized"],
    default: "normalized",
};

const keyboardMode = {
    type: "string",
    enum: ["hardware", "software"],
};

const supportedButtons = ["home", "lock", "power"];
const textInput = {
    type: "string",
    minLength: 1,
    maxLength: 20_000,
    pattern: "^[\\u0009\\u000A\\u0020-\\u007E]+$",
};
const normalizedCoordinate = { type: "number", minimum: 0, maximum: 1 };
const pointCoordinate = { type: "number" };

function coordinateProperties(names, includeDuration = false) {
    return {
        coordinateSpace,
        ...Object.fromEntries(names.map((name) => [name, pointCoordinate])),
        ...(includeDuration ? { durationMs: { type: "integer", minimum: 0, maximum: 60_000 } } : {}),
    };
}

function normalizedCoordinateRule(names) {
    return {
        if: {
            properties: { coordinateSpace: { const: "points" } },
            required: ["coordinateSpace"],
        },
        else: {
            properties: Object.fromEntries(names.map((name) => [name, normalizedCoordinate])),
        },
    };
}

function inputStep(kind, properties, required, rules = []) {
    return {
        type: "object",
        additionalProperties: false,
        properties: {
            kind: { const: kind },
            input: {
                type: "object",
                additionalProperties: false,
                properties,
                required,
                ...(rules.length > 0 ? { allOf: rules } : {}),
            },
        },
        required: ["kind", "input"],
    };
}

const tapCoordinates = ["x", "y"];
const swipeCoordinates = ["startX", "startY", "endX", "endY"];
const tapInputProperties = coordinateProperties(tapCoordinates, true);
const swipeInputProperties = {
    ...coordinateProperties(swipeCoordinates),
    durationMs: { type: "integer", minimum: 1, maximum: 60_000 },
};

const inputSteps = [
    inputStep("tap", tapInputProperties, tapCoordinates, [normalizedCoordinateRule(tapCoordinates)]),
    inputStep("swipe", swipeInputProperties, swipeCoordinates, [normalizedCoordinateRule(swipeCoordinates)]),
    inputStep(
        "key",
        {
            code: { type: "string", minLength: 1, maxLength: 64 },
            modifiers: {
                type: "array",
                items: { type: "string", enum: ["shift", "control", "option", "command"] },
                uniqueItems: true,
            },
            keyDown: { type: "boolean" },
        },
        ["code"],
    ),
    inputStep("text", { text: textInput }, ["text"]),
    inputStep(
        "button",
        { button: { type: "string", enum: supportedButtons } },
        ["button"],
    ),
    inputStep("rotate", { direction: { type: "string", enum: ["left", "right"] } }, ["direction"]),
];

export const openInputSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        udid: { type: "string", minLength: 1 },
        autoBoot: { type: "boolean" },
        bootAfterOpen: { type: "boolean" },
    },
};

export const actionSchemas = {
    getDeviceState: requiredUdid,
    acquireControl: {
        type: "object",
        additionalProperties: false,
        properties: {
            udid: { type: "string", minLength: 1 },
            reason: { type: "string", minLength: 1, maxLength: 240 },
            ttlSeconds: { type: "integer", minimum: 15, maximum: 900 },
        },
        required: ["udid"],
    },
    renewControl: {
        type: "object",
        additionalProperties: false,
        properties: {
            ...leaseFields,
            ttlSeconds: { type: "integer", minimum: 15, maximum: 900 },
        },
        required: ["udid", "leaseId"],
    },
    releaseControl: {
        type: "object",
        additionalProperties: false,
        properties: {
            ...leaseFields,
            reason: { type: "string", minLength: 1, maxLength: 240 },
        },
        required: ["udid", "leaseId"],
    },
    setKeyboardMode: {
        type: "object",
        additionalProperties: false,
        properties: {
            ...leaseFields,
            mode: keyboardMode,
        },
        required: ["udid", "leaseId", "mode"],
    },
    captureScreen: {
        type: "object",
        additionalProperties: false,
        properties: leaseFields,
        required: ["udid", "leaseId"],
    },
    startVideoRecording: {
        type: "object",
        additionalProperties: false,
        properties: {
            ...leaseFields,
            maxDurationSeconds: { type: "integer", minimum: 15, maximum: 900, default: 120 },
        },
        required: ["udid", "leaseId"],
    },
    stopVideoRecording: {
        type: "object",
        additionalProperties: false,
        properties: {
            ...leaseFields,
            recordingId: { type: "string", minLength: 1 },
        },
        required: ["udid", "leaseId", "recordingId"],
    },
    bootDevice: {
        type: "object",
        additionalProperties: false,
        properties: leaseFields,
        required: ["udid", "leaseId"],
    },
    shutdownDevice: {
        type: "object",
        additionalProperties: false,
        properties: leaseFields,
        required: ["udid", "leaseId"],
    },
    restartDevice: {
        type: "object",
        additionalProperties: false,
        properties: leaseFields,
        required: ["udid", "leaseId"],
    },
    rotateDevice: {
        type: "object",
        additionalProperties: false,
        properties: {
            ...leaseFields,
            direction: { type: "string", enum: ["left", "right"] },
        },
        required: ["udid", "leaseId", "direction"],
    },
    pressButton: {
        type: "object",
        additionalProperties: false,
        properties: {
            ...leaseFields,
            button: { type: "string", enum: supportedButtons },
        },
        required: ["udid", "leaseId", "button"],
    },
    tap: {
        type: "object",
        additionalProperties: false,
        properties: {
            ...leaseFields,
            ...tapInputProperties,
        },
        required: ["udid", "leaseId", ...tapCoordinates],
        allOf: [normalizedCoordinateRule(tapCoordinates)],
    },
    swipe: {
        type: "object",
        additionalProperties: false,
        properties: {
            ...leaseFields,
            ...swipeInputProperties,
        },
        required: ["udid", "leaseId", ...swipeCoordinates],
        allOf: [normalizedCoordinateRule(swipeCoordinates)],
    },
    sendKey: {
        type: "object",
        additionalProperties: false,
        properties: {
            ...leaseFields,
            code: { type: "string", minLength: 1, maxLength: 64 },
            modifiers: {
                type: "array",
                items: { type: "string", enum: ["shift", "control", "option", "command"] },
                uniqueItems: true,
            },
            keyDown: { type: "boolean" },
        },
        required: ["udid", "leaseId", "code"],
    },
    sendText: {
        type: "object",
        additionalProperties: false,
        properties: {
            ...leaseFields,
            text: textInput,
        },
        required: ["udid", "leaseId", "text"],
    },
    performInputs: {
        type: "object",
        additionalProperties: false,
        properties: {
            ...leaseFields,
            steps: {
                type: "array",
                minItems: 1,
                maxItems: 50,
                items: { oneOf: inputSteps },
            },
        },
        required: ["udid", "leaseId", "steps"],
    },
};
