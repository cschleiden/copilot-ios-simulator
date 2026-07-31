export class AppError extends Error {
    constructor(code, message, status = 400, details = undefined) {
        super(message);
        this.name = "AppError";
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

export function asAppError(error, fallbackCode = "internal_error", fallbackStatus = 500) {
    if (error instanceof AppError) {
        return error;
    }

    if (error instanceof Error) {
        return new AppError(fallbackCode, error.message, fallbackStatus);
    }

    return new AppError(fallbackCode, String(error), fallbackStatus);
}
