const { ApiError } = require('./errors');
const { isObject, badRequest } = require('./validation');

function parse(query, key, fallback) {
    if (query[key] === undefined) return fallback;
    if (typeof query[key] !== 'string') badRequest(`${key} must be a single JSON value.`);
    try {
        return JSON.parse(query[key]);
    } catch {
        badRequest(`${key} must contain valid JSON.`);
    }
}

function objectOption(query, key) {
    const value = parse(query, key, {});
    if (!isObject(value)) badRequest(`${key} must be a JSON object.`);
    return value;
}

function selection(query) {
    const value = objectOption(query, 'select');
    const entries = Object.entries(value);
    if (entries.some(([, direction]) => direction !== 0 && direction !== 1)) {
        badRequest('select values must be 0 or 1.');
    }
    if (new Set(entries.filter(([key]) => key !== '_id').map(([, direction]) => direction)).size > 1) {
        badRequest('select cannot mix included and excluded fields, except for _id.');
    }
    return value;
}

function collectionOptions(query, defaultLimit) {
    const where = objectOption(query, 'where');
    const sort = objectOption(query, 'sort');
    const select = selection(query);
    if (Object.values(sort).some(value => value !== 1 && value !== -1)) {
        badRequest('sort values must be 1 or -1.');
    }
    const skip = parse(query, 'skip', 0);
    const limit = parse(query, 'limit', defaultLimit);
    const count = parse(query, 'count', false);
    if (!Number.isSafeInteger(skip) || skip < 0) badRequest('skip must be a nonnegative integer.');
    if (!Number.isSafeInteger(limit) || limit < 0) badRequest('limit must be a nonnegative integer.');
    if (typeof count !== 'boolean') badRequest('count must be true or false.');
    return { where, sort, select, skip, limit, count };
}

async function execute(query) {
    try {
        return await query.exec();
    } catch (error) {
        // These are invalid filters/projections, rather than database outages.
        if (error.name === 'CastError' || error.name === 'StrictModeError' ||
            (error.name === 'MongoServerError' && [2, 9, 14, 72, 168, 15999, 31253, 31254].includes(error.code))) {
            throw new ApiError(400, 'A query field, operator, or value is invalid.');
        }
        throw error;
    }
}

async function list(Model, query, defaultLimit) {
    const options = collectionOptions(query, defaultLimit);
    // count means all documents matching where, independent of pagination/projection.
    if (options.count) return execute(Model.countDocuments(options.where));
    return execute(Model.find(options.where).sort(options.sort).select(options.select)
        .skip(options.skip).limit(options.limit).lean());
}

module.exports = { selection, execute, list };
