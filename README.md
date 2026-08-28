# Collaborative Code Editor

Real-time collaborative code editing: several people type in the same document at
once, see each other's cursors, and end up with identical text.

The editor UI is the least interesting part. What this repo is actually about is
what sits under it — CRDT conflict resolution, a WebSocket layer that survives
bad networks, and scaling a stateful connection across more than one process.

## Stack

| Layer | Choice |
| --- | --- |
| Server | Node 20 + TypeScript, [`ws`](https://github.com/websockets/ws) |
| CRDT | Yjs + `y-protocols` |
| Editor | CodeMirror 6 + `y-codemirror.next` |
| Client | React + Vite |

## Layout

```
apps/web         React client, CodeMirror, the reconnecting WebSocket provider
apps/server      WebSocket server, room registry, heartbeat
packages/protocol  Message framing shared by both sides
infra            docker-compose and load tests (phase 3)
```

npm workspaces, no monorepo tool. There are three packages; Turborepo would be
more configuration than it saves.

## Running it

```bash
npm install
npm run dev          # server on :8080, client on :5173
```

Open <http://localhost:5173?doc=demo> in two tabs and type in both.

```bash
npm test             # boots a real server and asserts convergence
```

Documents are held in memory unless `DATABASE_URL` is set, so the two commands
above need no database. To run with Postgres:

```bash
docker run -d --name cce-pg -p 55432:5432 \
  -e POSTGRES_USER=cce -e POSTGRES_PASSWORD=cce -e POSTGRES_DB=cce postgres:16-alpine

export DATABASE_URL=postgres://cce:cce@localhost:55432/cce
npm run db:setup -w @cce/server
npm run dev
```

---

## Phase 1 — single-node sync

Two tabs edit the same document and converge.

- One `Y.Doc` per document, held in memory, keyed by the `/doc/:id` path.
- Yjs sync protocol over binary frames; CodeMirror bound directly to the `Y.Text`.
- Server-side heartbeat that terminates sockets which stop answering.
- Client-side reconnect with exponential backoff and jitter.

`npm test` covers the done-condition: two clients insert at index 0 without
having seen each other's edit, and both end up with the same string.

### Why Yjs and not operational transform

OT needs a central server that serializes every operation and transforms it
against the history it has already applied. That server is the correctness
boundary, and it is also the thing you cannot easily run three of.

A CRDT moves the merge rule into the data structure. Concurrent edits commute, so
convergence does not depend on ordering, which means the server does not have to
be authoritative — it can be a relay. That is the property phase 3 depends on:
you cannot fan a document out through Redis to three instances if correctness
requires a single serialization point.

The cost is metadata. Every character carries a client ID and clock, and deleted
characters leave tombstones behind. Yjs is unusually good at compacting this, but
a document with a long editing history is bigger than its text.

### Why `ws` and not Socket.IO

Socket.IO ships reconnection, heartbeats and rooms, and hides all of them behind
its own framing and its own handshake. Two problems: the framing is text-oriented
and Yjs updates are binary, and the reconnect behaviour is exactly the part of
this project worth understanding.

`ws` is a WebSocket and nothing else, so [`provider.ts`](apps/web/src/collab/provider.ts)
and [`heartbeat.ts`](apps/server/src/ws/heartbeat.ts) are the entirety of the
liveness story and both are short enough to read.

### Why the heartbeat runs in both directions

The server pings each socket every 30s using WebSocket control frames and
terminates anything that has not ponged since the previous sweep. That catches
half-open connections — a laptop that slept, a phone that lost wifi — which TCP
alone will happily keep "open" for a long time.

That only works one way. The browser's WebSocket API answers pings automatically
but does not expose them to JavaScript, so a browser client cannot use the same
mechanism to notice a dead server. The client therefore sends its own
application-level `Ping` every 20s and drops the socket if no `Pong` comes back
within 10s, which puts it into the same reconnect path as any other disconnect.

### Why the frames are binary

Yjs updates are binary diffs. Putting one through `JSON.stringify` means base64
(+33%) or an array of numbers (worse), on every keystroke, for every client in
the room. The envelope is one type byte followed by the raw payload —
[`messages.ts`](packages/protocol/src/messages.ts).


---

## Phase 2a — persistence

Documents are stored as **one snapshot plus an append-only log of the updates
that came after it** ([`sql/schema.sql`](apps/server/sql/schema.sql)). A room is
loaded on the first join and dropped when the last client leaves, so an idle
instance holds nothing in memory.

`npm test` covers the done-condition: text written to one server process is
still there after that process exits and a new one starts against the same store.

### Why a log and not "save the document"

Writing the whole document on every change is O(document) per keystroke and it
makes two concurrent writers race — last write wins, and the loser's edits are
gone. Appending is O(update), never reads, never locks, and two instances
appending to the same document cannot conflict. Yjs updates are commutative and
idempotent, so replaying the log in any order rebuilds the same document.

The cost is read time: a document with 50k updates is 50k rows to replay. That is
what compaction is for. After `COMPACT_AFTER_UPDATES` appends, one transaction
rebuilds the snapshot from the log and truncates it.

Compaction reads its input from the database rather than from the live in-memory
document, and takes a `pg_advisory_xact_lock` on the document first. Both matter
once there is more than one instance: another process may have appended updates
this one has never seen, and folding the log away using only local state would
delete them.

### Why writes are batched, and what that costs

One insert per keystroke per editor is a lot of round trips for a free-tier
Postgres. Updates are merged in memory and flushed after a 500ms quiet period, so
a burst of typing becomes a single row
([`writer.ts`](apps/server/src/persistence/writer.ts)).

The durability guarantee is therefore explicit rather than absolute: **a hard
crash loses at most `PERSIST_DEBOUNCE_MS` of edits.** SIGTERM and the last client
leaving both flush first, so an ordinary restart or deploy loses nothing. If a
write fails the batch goes back on the queue and is retried, which is only safe
because Yjs updates commute — the retry does not have to keep its place in line.

### Why reconnecting is cheap

The client's first frame after connecting is sync step 1, which carries a *state
vector* — a small map of "the last clock I have seen from each author" — not the
document. The server replies with only the updates missing from it.

In the test suite a 50KB document costs ~50KB on a first connect and under 2KB
to resume after a dropout. This falls out of the sync protocol rather than being
something this repo implements, which is most of the argument for using Yjs.

### Why the gateway queues frames

Loading a document is asynchronous, but the client sends its state vector the
instant the socket opens. Those frames arrive before the room exists, so the
gateway holds up to 32 of them and drains them once the load finishes
([`gateway.ts`](apps/server/src/ws/gateway.ts)). Simultaneous joins to a cold
document share one read rather than each starting their own.
