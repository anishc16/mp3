class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function errorHandler(error, req, res, next) {
    if (res.headersSent) return next(error);
    let status = 500;
    let message = 'Unable to complete the request. Please try again.';
    if (error instanceof ApiError) {
        status = error.status;
        message = error.message;
    } else if (error.code === 11000) {
        status = 400;
        message = 'Email is already used by another user.';
    } else if (error.type === 'entity.parse.failed') {
        status = 400;
        message = 'Request body must contain valid JSON.';
    } else if (error.type === 'entity.too.large') {
        status = 400;
        message = 'Request body is too large.';
    } else if (error.name === 'CastError' || error.name === 'ValidationError') {
        status = 400;
        message = 'A field or query value is invalid.';
    }
    res.status(status).json({ message, data: null });
}

module.exports = { ApiError, errorHandler };
