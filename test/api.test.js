const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
// Keep downloaded test binaries out of the repository and the user's home cache.
process.env.MONGOMS_DOWNLOAD_DIR ||= path.join(os.tmpdir(), 'cs409-mp3-mongodb-binaries');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const { app } = require('../server');
const User = require('../models/user');
const Task = require('../models/task');

let replicaSet, server, base;
let sequence = 0;
const deadline = '2026-12-01T12:00:00.000Z';
const missingId = () => new mongoose.Types.ObjectId().toString();
const userBody = (extra = {}) => ({ name: 'Test User', email: `test-${++sequence}@example.com`, ...extra });
const taskBody = (extra = {}) => ({ name: 'Test Task', deadline, ...extra });
const query = options => `?${new URLSearchParams(Object.entries(options).map(([key, value]) => [key, JSON.stringify(value)]))}`;

before(async () => {
    // Never use MONGODB_URI from .env for tests or cleanup.
    replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await mongoose.connect(replicaSet.getUri(), { dbName: 'mp3_integration_test' });
    await Promise.all([User.init(), Task.init()]);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}/api`;
}, { timeout: 180000 });

beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Task.deleteMany({})]);
});

after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await mongoose.disconnect();
    if (replicaSet) await replicaSet.stop();
});

async function request(method, endpoint, body, expected = 200) {
    const response = await fetch(base + endpoint, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    const result = text ? JSON.parse(text) : undefined;
    assert.equal(response.status, expected, `${method} ${endpoint}: ${text}`);
    if (expected === 204) {
        assert.equal(text, '');
        assert.equal(response.headers.get('content-type'), null);
    } else {
        assert.equal(typeof result.message, 'string');
        assert.ok(result.message.length > 0);
        assert.ok(Object.hasOwn(result, 'data'));
    }
    return result?.data;
}

const createUser = extra => request('POST', '/users', userBody(extra), 201);
const createTask = extra => request('POST', '/tasks', taskBody(extra), 201);
const getUser = id => request('GET', `/users/${id}`);
const getTask = id => request('GET', `/tasks/${id}`);

async function snapshot() {
    const values = await Promise.all([User.find().sort('_id').lean(), Task.find().sort('_id').lean()]);
    return JSON.stringify(values);
}

async function invariant() {
    const [users, tasks] = await Promise.all([User.find().lean(), Task.find().lean()]);
    const userMap = new Map(users.map(user => [user._id.toString(), user]));
    const taskMap = new Map(tasks.map(task => [task._id.toString(), task]));
    for (const user of users) {
        assert.equal(new Set(user.pendingTasks).size, user.pendingTasks.length);
        for (const id of user.pendingTasks) {
            const task = taskMap.get(id);
            assert.ok(task, 'pending task exists');
            assert.equal(task.completed, false);
            assert.equal(task.assignedUser, user._id.toString());
            assert.equal(task.assignedUserName, user.name);
        }
    }
    for (const task of tasks) {
        if (!task.assignedUser) {
            assert.equal(task.assignedUserName, 'unassigned');
            continue;
        }
        const user = userMap.get(task.assignedUser);
        assert.ok(user, 'assigned user exists, including for completed tasks');
        assert.equal(task.assignedUserName, user.name);
        assert.equal(user.pendingTasks.includes(task._id.toString()), !task.completed);
    }
}

afterEach(invariant);

test('empty collection GETs return lists or zero counts, and root has a safe response', async () => {
    for (const resource of ['users', 'tasks']) {
        assert.deepEqual(await request('GET', `/${resource}`), []);
        assert.equal(await request('GET', `/${resource}?count=true`), 0);
        assert.deepEqual(await request('GET', `/${resource}${query({ where: { _id: missingId() } })}`), []);
    }
    const response = await fetch(base);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).message, 'Task management API');
});

test('POST schemas supply defaults and ignore client dates, IDs and unknown fields', async () => {
    const fakeId = missingId();
    const fields = { _id: fakeId, dateCreated: '1900-01-01', ignored: 'field' };
    const user = await createUser(fields);
    const task = await createTask(fields);
    assert.deepEqual(user.pendingTasks, []);
    assert.equal(task.description, '');
    assert.equal(task.completed, false);
    assert.equal(task.assignedUser, '');
    assert.equal(task.assignedUserName, 'unassigned');
    assert.equal(task.deadline, deadline);
    for (const value of [user, task]) {
        assert.notEqual(value._id, fakeId);
        assert.ok(Math.abs(Date.now() - Date.parse(value.dateCreated)) < 10000);
        assert.equal(value.ignored, undefined);
    }
    assert.deepEqual(await getUser(user._id), user);
    assert.deepEqual(await getTask(task._id), task);
});

for (const resource of ['users', 'tasks']) {
    for (const method of ['GET', 'PUT', 'DELETE']) {
        test(`${method} /${resource}/:id returns 404 for malformed and missing URL IDs before body validation`, async () => {
            const before = await snapshot();
            for (const id of ['invalid-id', missingId()]) {
                await request(method, `/${resource}/${id}`, method === 'PUT' ? {} : undefined, 404);
            }
            assert.equal(await snapshot(), before);
        });
    }
}

test('DELETE returns an empty 204 and subsequent GET/PUT/DELETE return 404', async () => {
    const user = await createUser();
    const task = await createTask({ assignedUser: user._id });
    for (const [resource, data] of [['tasks', task], ['users', user]]) {
        await request('DELETE', `/${resource}/${data._id}`, undefined, 204);
        await request('GET', `/${resource}/${data._id}`, undefined, 404);
        await request('PUT', `/${resource}/${data._id}`, {}, 404);
        await request('DELETE', `/${resource}/${data._id}`, undefined, 404);
    }
});

test('PUT replaces task fields, resets defaults, unassigns, and preserves server dateCreated', async () => {
    const user = await createUser();
    const task = await createTask({ description: 'old', completed: true, assignedUser: user._id });
    const result = await request('PUT', `/tasks/${task._id}`, taskBody({ dateCreated: null, _id: missingId() }));
    assert.equal(result._id, task._id);
    assert.equal(result.dateCreated, task.dateCreated);
    assert.equal(result.completed, false);
    assert.equal(result.description, '');
    assert.equal(result.assignedUser, '');
    assert.equal(result.assignedUserName, 'unassigned');
    assert.deepEqual((await getUser(user._id)).pendingTasks, []);
});

for (const resource of ['users', 'tasks']) {
    test(`single /${resource}/:id supports select and ignores every other query parameter`, async () => {
        const document = resource === 'users' ? await createUser() : await createTask();
        const result = await request('GET', `/${resource}/${document._id}${query({
            select: { name: 1, _id: 0 }, where: 'invalid JSON filter', sort: null,
            count: 'not a boolean', skip: -1, limit: 'bad'
        })}`);
        assert.deepEqual(result, { name: document.name });
        const excluded = await request('GET', `/${resource}/${document._id}${query({ select: { dateCreated: 0, _id: 0 } })}`);
        assert.equal(excluded.dateCreated, undefined);
        assert.equal(excluded._id, undefined);
        assert.equal(excluded.name, document.name);
        await request('GET', `/${resource}/${document._id}?select=bad`, undefined, 400);
    });
}

const invalidUsers = [
    ['missing name', { name: undefined }], ['missing email', { email: undefined }],
    ['blank name', { name: '  ' }], ['empty email', { email: '' }],
    ['numeric name', { name: 123 }], ['null name', { name: null }],
    ['object email', { email: {} }], ['array email', { email: ['a'] }],
    ['null pendingTasks', { pendingTasks: null }], ['scalar pendingTasks', { pendingTasks: 'x' }],
    ['malformed task ID', { pendingTasks: ['bad-id'] }],
    ['numeric task ID', { pendingTasks: [123] }], ['null task ID', { pendingTasks: [null] }]
];
const invalidTasks = [
    ['missing name', { name: undefined }], ['missing deadline', { deadline: undefined }],
    ['empty name', { name: '' }], ['numeric name', { name: 1 }], ['array name', { name: [] }],
    ['invalid date', { deadline: 'not-a-date' }], ['empty date', { deadline: '' }],
    ['null date', { deadline: null }], ['boolean date', { deadline: true }],
    ['object date', { deadline: {} }], ['array date', { deadline: [2026] }],
    ['string completed', { completed: 'false' }], ['numeric completed', { completed: 1 }],
    ['null completed', { completed: null }], ['object description', { description: {} }],
    ['null description', { description: null }], ['malformed assigned ID', { assignedUser: 'bad' }],
    ['numeric assigned ID', { assignedUser: 1 }], ['null assigned ID', { assignedUser: null }],
    ['non-string assigned name', { assignedUserName: 1 }], ['null assigned name', { assignedUserName: null }]
];

for (const [resource, invalid, build, create] of [
    ['users', invalidUsers, userBody, createUser], ['tasks', invalidTasks, taskBody, createTask]
]) {
    for (const [label, fields] of invalid) {
        for (const method of ['POST', 'PUT']) {
            test(`${method} /${resource}: ${label} gives 400 without changing anything`, async () => {
                const existing = await create();
                const before = await snapshot();
                await request(method, `/${resource}${method === 'PUT' ? `/${existing._id}` : ''}`, build(fields), 400);
                assert.equal(await snapshot(), before);
            });
        }
    }
    test(`/${resource} rejects non-object and absent bodies`, async () => {
        for (const body of [[], null, undefined]) await request('POST', `/${resource}`, body, 400);
    });
}

test('duplicate email is 400 on POST and PUT, but keeping your own email is allowed', async () => {
    const a = await createUser();
    const b = await createUser();
    const before = await snapshot();
    await request('POST', '/users', userBody({ email: a.email }), 400);
    await request('PUT', `/users/${b._id}`, userBody({ email: a.email }), 400);
    assert.equal(await snapshot(), before);
    const updated = await request('PUT', `/users/${a._id}`, { name: 'New Name', email: a.email, dateCreated: 'bad' });
    assert.equal(updated.dateCreated, a.dateCreated);
    assert.equal(updated.email, a.email);
});

test('reference existence and README error precedence are enforced without partial writes', async () => {
    const user = await createUser();
    const task = await createTask();
    const done = await createTask({ completed: true });
    const before = await snapshot();
    for (const method of ['POST', 'PUT']) {
        const userPath = `/users${method === 'PUT' ? `/${user._id}` : ''}`;
        const taskPath = `/tasks${method === 'PUT' ? `/${task._id}` : ''}`;
        await request(method, userPath, userBody({ pendingTasks: [task._id, missingId()] }), 404);
        await request(method, userPath, userBody({ pendingTasks: [done._id] }), 400);
        // README is authoritative over the FAQ's different mixed-error ordering.
        await request(method, userPath, userBody({ pendingTasks: [done._id, missingId()] }), 400);
        await request(method, userPath, userBody({ email: user.email, pendingTasks: [missingId()] }), method === 'POST' ? 400 : 404);
        await request(method, userPath, userBody({ name: null, pendingTasks: [missingId()] }), 400);
        await request(method, taskPath, taskBody({ assignedUser: missingId() }), 404);
        await request(method, taskPath, taskBody({ assignedUser: missingId(), completed: 'true' }), 400);
        await request(method, taskPath, taskBody({ assignedUser: user._id, assignedUserName: 'Wrong' }), 400);
    }
    assert.equal(await snapshot(), before);
});

test('POST assigned tasks fill the owner name and include only pending tasks on the user', async () => {
    const user = await createUser();
    const pending = await createTask({ assignedUser: user._id.toUpperCase() });
    const done = await createTask({ assignedUser: user._id, assignedUserName: user.name, completed: true });
    assert.equal(pending.assignedUser, user._id);
    assert.equal(pending.assignedUserName, user.name);
    assert.equal(done.assignedUser, user._id);
    assert.deepEqual((await getUser(user._id)).pendingTasks, [pending._id]);
});

test('task PUT handles assignment, reassignment, completion, completed reassignment, reopening, unassignment', async () => {
    const a = await createUser({ name: 'A' });
    const b = await createUser({ name: 'B' });
    const task = await createTask();
    const replace = extra => request('PUT', `/tasks/${task._id}`, taskBody(extra));
    await replace({ assignedUser: a._id });
    assert.deepEqual((await getUser(a._id)).pendingTasks, [task._id]);
    await replace({ assignedUser: b._id, assignedUserName: b.name });
    assert.deepEqual((await getUser(a._id)).pendingTasks, []);
    assert.deepEqual((await getUser(b._id)).pendingTasks, [task._id]);
    await replace({ assignedUser: b._id, completed: true });
    assert.deepEqual((await getUser(b._id)).pendingTasks, []);
    assert.equal((await getTask(task._id)).assignedUser, b._id);
    await replace({ assignedUser: a._id, completed: true });
    assert.equal((await getTask(task._id)).assignedUserName, a.name);
    assert.deepEqual((await getUser(a._id)).pendingTasks, []);
    await replace({ assignedUser: a._id, completed: false });
    await replace({ assignedUser: a._id, completed: false });
    assert.deepEqual((await getUser(a._id)).pendingTasks, [task._id]);
    const unassigned = await replace({ assignedUser: '', assignedUserName: a.name });
    assert.equal(unassigned.assignedUserName, 'unassigned');
    assert.deepEqual((await getUser(a._id)).pendingTasks, []);
});

test('POST user with pendingTasks assigns and moves tasks from another owner', async () => {
    const a = await createUser();
    const first = await createTask({ assignedUser: a._id });
    const second = await createTask();
    const b = await createUser({ name: 'B', pendingTasks: [first._id.toUpperCase(), first._id, second._id] });
    assert.deepEqual((await getUser(a._id)).pendingTasks, []);
    assert.deepEqual(b.pendingTasks, [first._id, second._id]);
    for (const task of [first, second]) {
        const updated = await getTask(task._id);
        assert.equal(updated.assignedUser, b._id);
        assert.equal(updated.assignedUserName, 'B');
    }
});

test('PUT user keeps, adds, removes, moves tasks and renames all assigned tasks including completed', async () => {
    const a = await createUser({ name: 'A' });
    const b = await createUser({ name: 'B' });
    const kept = await createTask({ assignedUser: a._id });
    const removed = await createTask({ assignedUser: a._id });
    const done = await createTask({ assignedUser: a._id, completed: true });
    const moved = await createTask({ assignedUser: b._id });
    const added = await createTask();
    const next = [kept._id, moved._id, added._id];
    const updated = await request('PUT', `/users/${a._id}`, { name: 'Renamed', email: a.email, pendingTasks: next, dateCreated: '1900-01-01' });
    assert.deepEqual(updated.pendingTasks, next);
    assert.equal(updated.dateCreated, a.dateCreated);
    assert.deepEqual((await getUser(b._id)).pendingTasks, []);
    assert.equal((await getTask(removed._id)).assignedUser, '');
    for (const task of [kept, done, moved, added]) {
        assert.equal((await getTask(task._id)).assignedUserName, 'Renamed');
    }
    assert.equal((await getTask(done._id)).completed, true);
});

test('PUT user missing pendingTasks empties the list but retains completed task ownership and updates names', async () => {
    const user = await createUser();
    const pending = await createTask({ assignedUser: user._id });
    const done = await createTask({ assignedUser: user._id, completed: true });
    const updated = await request('PUT', `/users/${user._id}`, { name: 'Replacement', email: user.email });
    assert.deepEqual(updated.pendingTasks, []);
    assert.equal((await getTask(pending._id)).assignedUser, '');
    assert.equal((await getTask(done._id)).assignedUser, user._id);
    assert.equal((await getTask(done._id)).assignedUserName, 'Replacement');
});

test('DELETE user unassigns pending and completed tasks, leaving other users alone', async () => {
    const a = await createUser();
    const b = await createUser();
    const pending = await createTask({ assignedUser: a._id });
    const done = await createTask({ assignedUser: a._id, completed: true });
    const untouched = await createTask({ assignedUser: b._id });
    await request('DELETE', `/users/${a._id}`, undefined, 204);
    for (const task of [pending, done]) {
        const updated = await getTask(task._id);
        assert.equal(updated.assignedUser, '');
        assert.equal(updated.assignedUserName, 'unassigned');
    }
    assert.equal((await getTask(done._id)).completed, true);
    assert.equal((await getTask(untouched._id)).assignedUser, b._id);
});

test('DELETE pending and completed tasks removes references without deleting their user', async () => {
    const user = await createUser();
    const pending = await createTask({ assignedUser: user._id });
    const done = await createTask({ assignedUser: user._id, completed: true });
    const kept = await createTask({ assignedUser: user._id });
    await request('DELETE', `/tasks/${pending._id}`, undefined, 204);
    await request('DELETE', `/tasks/${done._id}`, undefined, 204);
    assert.deepEqual((await getUser(user._id)).pendingTasks, [kept._id]);
});

test('all 64 combinations of collection query parameters work together', async () => {
    const tasks = [];
    for (let i = 0; i < 5; i++) tasks.push(await createTask({ name: `Task ${i}`, completed: i % 2 === 1 }));
    const entries = Object.entries({ where: { completed: false }, sort: { name: -1 }, select: { name: 1, _id: 0 }, skip: 1, limit: 2, count: true });
    for (let mask = 0; mask < 64; mask++) {
        const options = Object.fromEntries(entries.filter((_, index) => mask & (1 << index)));
        let expected = tasks.filter(task => !options.where || !task.completed);
        if (options.count) {
            assert.equal(await request('GET', `/tasks${query(options)}`), expected.length);
            continue;
        }
        if (options.sort) expected.reverse();
        expected = expected.slice(options.skip || 0, (options.skip || 0) + (options.limit || 100));
        if (options.select) expected = expected.map(task => ({ name: task.name }));
        assert.deepEqual(await request('GET', `/tasks${query(options)}`), expected, `combination ${mask}`);
    }
});

test('where supports $in, $or, comparisons, dates, regex, and users queries support combinations', async () => {
    const a = await createUser({ name: 'Alpha' });
    const b = await createUser({ name: 'Beta' });
    await createUser({ name: 'Charlie' });
    const result = await request('GET', `/users${query({ where: { _id: { $in: [a._id, b._id] } }, sort: { name: -1 }, select: { name: 1, _id: 0 }, skip: 1, limit: 1 })}`);
    assert.deepEqual(result, [{ name: 'Alpha' }]);
    assert.equal(await request('GET', `/users${query({ where: { name: { $regex: '^A' } }, count: true })}`), 1);
    await createTask({ name: 'Early', deadline: '2026-01-01' });
    const late = await createTask({ name: 'Late', deadline: '2027-01-01', completed: true });
    assert.deepEqual(await request('GET', `/tasks${query({ where: { deadline: { $gte: '2026-12-01' } } })}`), [late]);
    assert.equal(await request('GET', `/tasks${query({ where: { $or: [{ name: 'Early' }, { completed: true }] }, count: true })}`), 2);
});

test('tasks default limit is 100, users are unlimited, limit=0 is unlimited, count ignores pagination', async () => {
    await Task.insertMany(Array.from({ length: 105 }, (_, i) => taskBody({ name: `Bulk ${i}` })));
    await User.insertMany(Array.from({ length: 105 }, () => userBody()));
    assert.equal((await request('GET', '/tasks')).length, 100);
    assert.equal((await request('GET', '/tasks?limit=0')).length, 105);
    assert.equal((await request('GET', '/tasks?skip=100')).length, 5);
    assert.equal((await request('GET', '/users')).length, 105);
    assert.equal(await request('GET', '/tasks?count=true&skip=100&limit=1'), 105);
});

const invalidQueries = [
    'where={', 'sort={', 'select={', 'skip=NaN', 'limit=NaN', 'count=TRUE',
    'where=null', 'where=[]', 'where=1', 'sort=[]', 'select=null',
    'skip=-1', 'skip=1.5', 'skip=%222%22', 'limit=-1', 'limit=true', 'limit=null',
    'count=1', 'count=%22true%22', 'where={}&where={}',
    new URLSearchParams({ sort: JSON.stringify({ name: 0 }) }).toString(),
    new URLSearchParams({ select: JSON.stringify({ name: 2 }) }).toString(),
    new URLSearchParams({ select: JSON.stringify({ name: 1, dateCreated: 0 }) }).toString(),
    new URLSearchParams({ where: JSON.stringify({ _id: 'bad-id' }) }).toString(),
    new URLSearchParams({ where: JSON.stringify({ $invalidOperator: 1 }) }).toString()
];
for (const resource of ['users', 'tasks']) {
    for (const invalid of invalidQueries) {
        test(`GET /${resource}?${invalid} returns a safe 400`, async () => {
            await request('GET', `/${resource}?${invalid}`, undefined, 400);
        });
    }
}

test('malformed JSON, unknown routes, and CORS preflight have the required response format', async () => {
    const response = await fetch(`${base}/users`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(typeof body.message, 'string');
    assert.equal(body.data, null);
    await request('GET', '/does-not-exist', undefined, 404);
    await request('OPTIONS', '/tasks', undefined, 204);
});

test('task transaction rolls back both owners after a failure following reference writes', async t => {
    const a = await createUser();
    const b = await createUser();
    const task = await createTask({ assignedUser: a._id });
    const before = await snapshot();
    const mock = t.mock.method(Task.prototype, 'save', async () => { throw new Error('Mongoose secret database detail'); });
    await request('PUT', `/tasks/${task._id}`, taskBody({ assignedUser: b._id }), 500);
    mock.mock.restore();
    assert.equal(await snapshot(), before);
});

test('user transaction rolls back user replacement and already-unassigned tasks on later failure', async t => {
    const user = await createUser();
    await createTask({ assignedUser: user._id });
    const before = await snapshot();
    const original = Task.updateMany;
    let calls = 0;
    const mock = t.mock.method(Task, 'updateMany', function (...args) {
        if (++calls === 2) throw new Error('MongoDB private detail');
        return original.apply(this, args);
    });
    await request('PUT', `/users/${user._id}`, { name: 'Changed', email: user.email }, 500);
    mock.mock.restore();
    assert.equal(await snapshot(), before);
});

test('DELETE user rolls back deletion if task cleanup fails', async t => {
    const user = await createUser();
    await createTask({ assignedUser: user._id });
    const before = await snapshot();
    const mock = t.mock.method(Task, 'updateMany', () => { throw new Error('database unavailable'); });
    await request('DELETE', `/users/${user._id}`, undefined, 500);
    mock.mock.restore();
    assert.equal(await snapshot(), before);
});

test('DELETE task rolls back reference cleanup if deletion fails', async t => {
    const user = await createUser();
    const task = await createTask({ assignedUser: user._id });
    const before = await snapshot();
    const mock = t.mock.method(Task.prototype, 'deleteOne', () => { throw new Error('database unavailable'); });
    await request('DELETE', `/tasks/${task._id}`, undefined, 500);
    mock.mock.restore();
    assert.equal(await snapshot(), before);
});

test('unexpected database errors return sanitized 500 responses', async t => {
    const mock = t.mock.method(Task, 'find', () => { throw new Error('mongodb://secret-password/private'); });
    const response = await fetch(`${base}/tasks`);
    assert.equal(response.status, 500);
    const text = await response.text();
    assert.doesNotMatch(text, /secret|mongodb|mongoose|private|stack/i);
    assert.equal(JSON.parse(text).data, null);
    mock.mock.restore();
});

test('concurrent duplicate emails create exactly one user', async () => {
    const body = userBody();
    const responses = await Promise.all(Array.from({ length: 4 }, () => fetch(`${base}/users`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })));
    assert.deepEqual(responses.map(response => response.status).sort(), [201, 400, 400, 400]);
    await Promise.all(responses.map(response => response.text()));
    assert.equal(await User.countDocuments(), 1);
});

test('concurrent completed task creation and user rename keep the stored name synchronized', async () => {
    for (let i = 0; i < 4; i++) {
        const user = await createUser({ name: 'Before' });
        await Promise.all([
            createTask({ assignedUser: user._id, completed: true }),
            request('PUT', `/users/${user._id}`, { name: 'After', email: user.email })
        ]);
        await invariant();
    }
});

test('concurrent user deletion and task creation cannot leave an orphan (pending or completed)', async () => {
    for (const completed of [false, true, false, true]) {
        const user = await createUser();
        const [created] = await Promise.all([
            fetch(`${base}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(taskBody({ assignedUser: user._id, completed })) }),
            request('DELETE', `/users/${user._id}`, undefined, 204)
        ]);
        assert.ok([201, 404].includes(created.status), await created.text());
        await invariant();
    }
});

test('concurrent task replacements preserve a single owner with no duplicate pending references', async () => {
    const users = await Promise.all([createUser(), createUser(), createUser()]);
    const task = await createTask({ assignedUser: users[0]._id });
    await Promise.all(users.map(user => request('PUT', `/tasks/${task._id}`, taskBody({ assignedUser: user._id }))));
    await invariant();
});

test('concurrent user task moves and completion preserve the two-way invariant', async () => {
    for (let i = 0; i < 4; i++) {
        const a = await createUser();
        const b = await createUser();
        const task = await createTask({ assignedUser: a._id });
        const [moved] = await Promise.all([
            fetch(`${base}/users/${b._id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: b.name, email: b.email, pendingTasks: [task._id] }) }),
            request('PUT', `/tasks/${task._id}`, taskBody({ assignedUser: a._id, completed: true }))
        ]);
        assert.ok([200, 400].includes(moved.status), await moved.text());
        await invariant();
    }
});

test('concurrent task deletion and user replacement cannot retain a deleted pending task', async () => {
    for (let i = 0; i < 4; i++) {
        const user = await createUser();
        const task = await createTask();
        const [assigned] = await Promise.all([
            fetch(`${base}/users/${user._id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: user.name, email: user.email, pendingTasks: [task._id] }) }),
            request('DELETE', `/tasks/${task._id}`, undefined, 204)
        ]);
        assert.ok([200, 404].includes(assigned.status), await assigned.text());
        await invariant();
    }
});
