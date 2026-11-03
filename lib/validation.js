const { ApiError } = require('./errors');

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = value => typeof value === 'string' && /^[a-fA-F0-9]{24}$/.test(value);

function badRequest(message) {
    throw new ApiError(400, message);
}

function requiredString(body, field) {
    if (typeof body[field] !== 'string' || !body[field].trim()) {
        badRequest(`${field} must be a nonempty string.`);
    }
    return body[field];
}

function optional(body, field, type, fallback) {
    if (body[field] === undefined) return fallback;
    if (typeof body[field] !== type) badRequest(`${field} must be a ${type}.`);
    return body[field];
}

function validateBody(body) {
    if (!isObject(body)) badRequest('Request body must be an object.');
}

function userFields(body) {
    validateBody(body);
    const name = requiredString(body, 'name');
    const email = requiredString(body, 'email');
    const pending = body.pendingTasks === undefined ? [] : body.pendingTasks;
    if (!Array.isArray(pending) || pending.some(id => !isId(id))) {
        badRequest('pendingTasks must be a list of valid task IDs.');
    }
    return { name, email, pendingTasks: [...new Set(pending.map(id => id.toLowerCase()))] };
}

function taskFields(body) {
    validateBody(body);
    const name = requiredString(body, 'name');
    const value = body.deadline;
    if ((typeof value !== 'string' && typeof value !== 'number') ||
        (typeof value === 'string' && !value.trim()) || !Number.isFinite(new Date(value).getTime())) {
        badRequest('deadline must be a valid date string or timestamp.');
    }
    const description = optional(body, 'description', 'string', '');
    const completed = optional(body, 'completed', 'boolean', false);
    const assignedUser = optional(body, 'assignedUser', 'string', '');
    const assignedUserName = optional(body, 'assignedUserName', 'string', undefined);
    if (assignedUser !== '' && !isId(assignedUser)) badRequest('assignedUser must be a valid user ID or an empty string.');
    return {
        name, description, deadline: new Date(value), completed,
        assignedUser: assignedUser.toLowerCase(), assignedUserName
    };
}

module.exports = { isObject, isId, badRequest, userFields, taskFields };
