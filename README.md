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


---

## Phase 2b — authentication

The socket authenticates itself before it is allowed near a document. A
connection starts in an unauthenticated state, must send a signed token as its
very first frame, and is dropped after 5 seconds if it does not
([`connection.ts`](apps/server/src/ws/connection.ts)). No room is loaded and no
document state is sent until the token verifies, so an unauthenticated socket
costs one timer and nothing else.

### Why the token travels in the first message

Browsers cannot set headers on a WebSocket handshake — `new WebSocket(url,
protocols)` is the entire API — so the usual `Authorization: Bearer` is not
available. The alternatives:

| Approach | Why not |
| --- | --- |
| `?token=...` in the URL | The URL ends up in access logs, proxy logs and error reports. A bearer token in a log file is a leaked credential. |
| Cookie | The client is on Vercel and the server on Render: different sites, so it needs `SameSite=None; Secure` plus CORS credentials, and browsers are actively restricting exactly that. |
| Smuggle it in `Sec-WebSocket-Protocol` | Works everywhere, but abuses a header meant for protocol negotiation and constrains the token's charset. |
| **First message after connect** | The socket exists before we know who owns it. Bounded with a timeout and a room that is not touched until the token verifies. |

The last one is the only option whose downside is something the server controls.

### Why the token is hand-rolled and not a JWT library

`base64url(claims).base64url(hmac_sha256(claims))`, verified with
`timingSafeEqual` ([`token.ts`](apps/server/src/auth/token.ts)). One algorithm,
one key, and no `alg` field for an attacker to set to `none` — which is the
classic JWT vulnerability and is unreachable here because there is nothing to
negotiate.

What it gives up is everything a real deployment eventually wants: asymmetric
keys, JWKS, rotation, revocation. Those come from an identity provider, and the
point at which one gets plugged in is `createSession` in
[`http.ts`](apps/server/src/http.ts) — nothing else would change.

### What this deliberately is not

`POST /api/session` hands a token to anyone who asks and takes the display name
on trust, and any authenticated user may open any document. There is no account
system and no per-document authorization. This establishes the *mechanism* —
signed, short-lived, expiring credentials that the socket verifies before
joining — not identity.

`AUTH_SECRET` has to be the same on every instance. Nothing pins a client to the
instance that issued its token, so a token minted by one has to verify on any
other.

### Expiry without kicking people out

Tokens last an hour, and an editing session can last longer. The client fetches
its token *before* opening each socket rather than after, refreshing when the
current one is close to expiring ([`auth.ts`](apps/web/src/auth.ts)). If the
server ever does refuse a token, the client clears it and reconnects with a
fresh one, so `Unauthorized` is a retryable close code rather than a terminal
one.

---

## Phase 2c — presence

Cursors, selections and names are carried on the awareness protocol, which is a
separate message type on a separate code path that never reaches the store.

The server tracks which awareness client IDs each socket introduced
([`client.ts`](apps/server/src/ws/client.ts)) and removes exactly those when the
socket closes, so a dropped connection cannot leave a ghost cursor behind. The
browser also announces its own departure on `beforeunload` while the socket is
still open, so a closed tab disappears immediately instead of at the next
heartbeat sweep.

The distinction is the point: **document state is durable and must never lose an
update; presence is disposable and must never outlive its connection.** They get
opposite treatment everywhere — different message types, different broadcast
paths, and only one of them is written down. `npm test` asserts that a
document's stored state comes back with the text and none of the cursors.

---

## Phase 3a — more than one server

A WebSocket connection is state pinned to one process. Two people editing the
same document land on different instances behind a load balancer, and by default
neither ever hears the other.

Every room subscribes to a Redis channel named after its document. A local edit
is broadcast to the sockets on this instance and published to that channel; an
instance that receives one applies it to its copy of the document, which fans it
out to its own sockets by the same path a local edit takes.

```
browser ──▶ instance A ──┐                      ┌──▶ browser
                         ├── redis cce:doc:x ───┤
browser ──▶ instance C ──┘                      └──▶ browser
```

### Why this is a relay and not a queue

Nothing on the bus is stored, acknowledged or replayed. Redis here is a fanout
mechanism, not a source of truth — Postgres is. That is what makes the failure
mode survivable: if Redis is unreachable, each instance keeps serving the clients
connected to it, and only cross-instance traffic stops. A partition, not an
outage.

It also means a dropped message is not a lost edit. The bus carries CRDT updates,
which are commutative and idempotent, so a client that missed one converges the
moment it receives any later state that contains it.

This is the argument for CRDTs over OT, cashed in. Operational transform needs a
single authoritative point that sees every operation in order to transform
against — which is exactly the thing three interchangeable instances do not have.
Yjs pushes the merge rule into the data structure, so relaying is enough and
ordering is not our problem.

### One channel per document

Not one channel for everything: an instance holding three documents should not
have to decode traffic for the other thousand. Rooms already appear and disappear
with their last client, so subscribing and unsubscribing along with them costs
nothing extra.

### Who writes to Postgres

An update is persisted by the instance that accepted it, and not by the instances
that receive it over the bus. Recording it everywhere would write the same bytes
once per instance and trigger compaction that many times sooner.

The trade is real and worth stating: if the accepting instance dies inside its
write-debounce window, its peers hold that edit in memory but will not save it.
That is the same bounded loss Phase 2a already documented, now with a second way
to reach it. Making it airtight needs the peers to take over persistence for a
dead instance, which needs leader election, which needs a failure story of its
own. Not worth it here.

### Why a new instance cannot trust the database

When an instance opens a document nobody there was editing, it reads from
Postgres — and that read is stale by construction, because the instances already
holding the document have accepted updates that are still in their write buffers.
Presence is worse: it is never written down at all, so a database read says the
room is empty even when four people are in it.

So opening a room publishes a state request, and every instance already holding
that document answers with its full state and its current awareness. Redundant
bytes, but they cost the receiver a merge it was going to do anyway, and it
closes the window between reading storage and subscribing to the channel.

### Shutting down when Redis is not there

`QUIT` only completes while connected; on a client that never reached the broker
it sits in the offline queue forever. Stopping the reconnect loop takes
`disconnect()`, and without it a server that starts with Redis down will not exit
on `SIGTERM` — a container that has to be killed rather than one that drains.
Found by running it, not by reading it.

Two Redis connections, not one: a client in subscriber mode may not issue
ordinary commands, so publishing needs its own.

### Testing this

`cluster.test.ts` runs several instances in one process against an in-process
bus, which is enough to prove the room logic — including one test where the store
deliberately keeps nothing, so the only way the second instance can have the
document is the state request. `redis-bus.test.ts` runs the same scenarios
through a real broker to prove the framing survives the round trip and that an
instance ignores the copy of its own publish that Redis hands back. It skips
unless `TEST_REDIS_URL` is set.
