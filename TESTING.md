# Local implementation and verification

Use Node.js 24 and the existing `.env` containing `MONGODB_URI`. `PORT` defaults to 3000.

```sh
npm install
npm test
npm start
```

The server waits for the database connection and the unique email index before accepting requests. Startup logs never include connection strings. Transactions require a MongoDB replica set, as provided by Atlas.

## Automated tests

Verified locally: **156 tests passed, 0 failed**. Atlas connection/ping, server startup, and read-only API smoke checks also passed. `npm audit --omit=dev` reported zero production vulnerabilities.

`npm test` uses Node's built-in test runner and a disposable local MongoDB replica set supplied by the development dependency `mongodb-memory-server`. It does **not** connect to or clear the Atlas database from `.env`. The first run downloads a MongoDB binary into the operating system's temporary directory and needs internet access. The tests start MongoDB and HTTP listeners on temporary ports and stop them afterward.

Coverage includes:

- Every user and task CRUD endpoint, defaults, generated dates, and replacement semantics.
- Required fields, strict request types, invalid dates, duplicate emails, malformed IDs, missing resources, and inconsistent assignment names.
- All 64 subsets of `where`, `sort`, `select`, `skip`, `limit`, and `count` on tasks; combined user queries; comparison, logical, date, regex, and ID filters.
- Task limit 100, unlimited users, explicit unlimited `limit=0`, selection on individual resources, and ignored non-select options on individual resources.
- Both directions of assignment, moving tasks via POST/PUT users, completion, reopening, renaming, unassignment, replacement, and deletion (including completed tasks).
- No database changes after validation failures; transaction rollback after injected failures following writes.
- Concurrent email creation, task reassignment, user renaming/deletion, task creation/deletion, and user task moves versus completion.
- The two-way-reference invariant checked after every test, safe errors, JSON envelopes, CORS, and empty 204 responses.

The README takes precedence over the FAQ. In particular, if `pendingTasks` contains both an existing completed task and a missing task, the README's invalid-values-first rule gives 400. Count returns all documents matching `where`; pagination, sort, and projection do not reduce the count. Unassigning a task normalizes its name to `unassigned`. Duplicate pending task IDs are normalized to one lowercase ID.

## Manual HTTP checks

With `npm start` running in another terminal:

```sh
curl -i http://localhost:3000/api/users

curl -i -X POST http://localhost:3000/api/users \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ada","email":"ada-local@example.com"}'
```

Copy the returned user's `_id` into `USER_ID` below:

```sh
USER_ID='paste-user-id-here'
curl -i -X POST http://localhost:3000/api/tasks \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"Finish MP3\",\"deadline\":\"2026-11-03T23:59:00-06:00\",\"assignedUser\":\"$USER_ID\"}"

curl -s "http://localhost:3000/api/users/$USER_ID"

curl -sG http://localhost:3000/api/tasks \
  --data-urlencode 'where={"completed":false}' \
  --data-urlencode 'sort={"deadline":1}' \
  --data-urlencode 'select={"name":1,"assignedUserName":1,"_id":0}' \
  --data-urlencode 'skip=0' --data-urlencode 'limit=10'
```

Copy the task's `_id` into `TASK_ID`. Completing the task removes it from the user's pending list while retaining its assignment:

```sh
TASK_ID='paste-task-id-here'
curl -i -X PUT "http://localhost:3000/api/tasks/$TASK_ID" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"Finish MP3\",\"deadline\":\"2026-11-03T23:59:00-06:00\",\"completed\":true,\"assignedUser\":\"$USER_ID\"}"

curl -s "http://localhost:3000/api/users/$USER_ID"
curl -i -X DELETE "http://localhost:3000/api/tasks/$TASK_ID"
curl -i -X DELETE "http://localhost:3000/api/users/$USER_ID"
```

DELETE returns 204 with an empty body. Repeating a DELETE or fetching the deleted resource gives 404. Change the port in these commands if you set `PORT`.

## Scope and sources

No deployment, push, or autograder invocation is part of this local verification. `submit.js`, its `AUTOGRADER_URL`, and `.gitignore` remain unchanged. The runtime dependency lock entries for `body-parser` and `qs` were updated to compatible patched versions; npm still reports two moderate development-only advisories via `nodemon`/`minimatch`.

The assignment specification is `README.md`, with `FAQ.md` as supporting clarification. Implementation references were the official [Mongoose transaction documentation](https://mongoosejs.com/docs/transactions.html) and [Mongoose query API](https://mongoosejs.com/docs/api/query.html). The README requires declaring sources and, when using generated code, submitting chatlogs and completing the LLM survey with the assignment.
