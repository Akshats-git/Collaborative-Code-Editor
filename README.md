# Collaborative Code Editor

Several people type in the same document at once, see each other's cursors, and
end up with identical text.

The editor UI is the least interesting part. What this repo is about is what
sits under it: CRDT conflict resolution, a WebSocket layer that survives bad
networks, and scaling a stateful connection across more than one process.

| Layer | Choice |
| --- | --- |
| Server | Node 20, TypeScript, [`ws`](https://github.com/websockets/ws) |
| CRDT | Yjs and `y-protocols` |
| Editor | CodeMirror 6 with `y-codemirror.next` |
| Client | React and Vite |
| Storage | Postgres (optional), Redis for cross-instance fanout (optional) |

## Layout

```
apps/server         WebSocket gateway, rooms, persistence, cluster bus
apps/web            React client, CodeMirror, reconnecting provider
packages/protocol   Message framing shared by both sides
infra               docker-compose stack, nginx config, k6 load test
```

npm workspaces, no monorepo tool. Three packages do not justify one.

## Running it

```bash
npm install
npm run dev          # server on :8080, client on :5173
```

Open <http://localhost:5173>, create a room, and paste the link into a second
tab. Both tabs are in the same document.

```bash
npm test             # boots a real server and asserts convergence
```

Documents live in memory unless `DATABASE_URL` is set, so neither command needs
a database. To run with Postgres:

```bash
docker run -d --name cce-pg -p 55432:5432 \
  -e POSTGRES_USER=cce -e POSTGRES_PASSWORD=cce -e POSTGRES_DB=cce postgres:16-alpine

export DATABASE_URL=postgres://cce:cce@localhost:55432/cce
npm run db:setup -w @cce/server
npm run dev
```

### Three instances behind nginx

`npm run dev` is one server. A single instance cannot exercise the Redis path,
because it only ever agrees with itself. The full stack runs Postgres, Redis and
three server instances behind nginx on `localhost:8080`:

```bash
npm run stack:up
VITE_WS_URL=ws://localhost:8080 npm run dev -w @cce/web
npm run stack:logs   # follow all three instances
npm run stack:down
```

nginx balances round robin, so two tabs land on different instances. The
instance id in each log line shows which.

## How it works

**Conflict resolution is Yjs.** Concurrent edits at the same position merge
without a server round trip, which means the server never has to be the
arbiter of ordering and an offline client can keep typing. Operational
transform would have put that ordering logic on the server and made every
reconnect a resync problem.

**The wire format is binary.** One type byte and an opaque payload. Yjs updates
are already compact binary diffs, so base64 in JSON would only inflate them.

**Documents are a snapshot plus an append-only log.** Appending never reads and
never locks, so two instances writing the same document do not contend.
Compaction folds the log back into the snapshot every 200 rows. Writes are
batched behind a 500ms debounce, so a burst of typing becomes one row and a hard
crash loses at most that window. SIGTERM and the last client leaving both flush
first.

**Auth is a signed short-lived token**, sent as the first frame on the socket.
It is hand rolled rather than a JWT library: one algorithm, one key, no `alg`
field to attack. There is no account system behind it, so what it establishes is
the mechanism rather than an identity. A room id is the credential, in the same
way an "anyone with the link" share is.

**Instances talk over Redis pub/sub**, one channel per document. Redis is a
relay and never a source of truth, so an unreachable broker degrades to a
partition rather than an outage: each instance keeps serving its own clients,
and rooms reconverge through the state request every instance issues when it
opens a document.

**Presence is droppable and document traffic is not.** That single rule decides
the backpressure policy in both directions. A client whose send buffer passes
256KB stops receiving cursor updates, and one that passes 4MB gets closed so it
can resync from its state vector. Inbound, a client over its presence budget
loses those frames, while one over its document budget is closed, because it
believes its edit was delivered.

## Numbers

[`infra/k6/editing.js`](infra/k6/editing.js) measures the round trip from a
keystroke leaving one socket to the update arriving on another, through nginx,
the gateway, the room, Redis and back out through a second instance.

2,000 sessions holding 4,000 sockets, ramped over two minutes, one edit every
400ms. Everything on one 12-core laptop, so the load generator competes with the
servers for cores and these are conservative:

| | |
| --- | --- |
| peak concurrent connections | **3,895** |
| edits delivered | 417,184 (**3,090/s**) |
| propagation p50 / p95 / **p99** | 5 ms / 16 ms / **30 ms** |
| edits lost | 0 |
| failed connections | 2 of 8,598 |
| memory per instance | ~275 MB |

Rerunning with the write debounce at 5s instead of 500ms drops Postgres CPU from
172% to 36% and p99 from 30ms to 26ms. Persistence costs about a third of the
server CPU for roughly 15% of the p99, so the durability setting is a real
throughput dial. Note that one document per user is the worst possible shape for
write amplification, since no two users' edits ever batch together. Real usage
folds many people into one insert.

## Deploying

One service. The server holds sockets open anyway, so it serves the built client
too, and the client defaults to the origin it was served from. That removes a
second origin, the CORS between them, and the ordering problem where each deploy
needs the other's URL before it can build.

Point Render at this repo as a Blueprint. [`render.yaml`](render.yaml) builds
[`apps/server/Dockerfile`](apps/server/Dockerfile) from the workspace root into
one image and generates `AUTH_SECRET`. Nothing else is required.

| Variable | Required | Value |
| --- | --- | --- |
| `AUTH_SECRET` | yes | generated by Render, identical on every instance |
| `DATABASE_URL` | no | Neon URL, with `?sslmode=require` |
| `REDIS_URL` | no | Upstash URL, only useful past one instance |

The server refuses to start without `AUTH_SECRET` in production. A random
per-process key is a local convenience, but deployed it means every restart
invalidates every token.

To keep documents, apply the schema once from anywhere that can reach the
database. Run it locally rather than in the container, because `db:setup` goes
through `tsx` and the runtime image is built with `--omit=dev`:

```bash
DATABASE_URL='postgres://…?sslmode=require' npm run db:setup -w @cce/server
```

See [`.env.example`](.env.example) for every setting and its default.
