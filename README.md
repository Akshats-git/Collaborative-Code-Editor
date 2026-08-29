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

### The three-instance stack

`npm run dev` is one server. To run the setup Phase 3 is actually about --
Postgres, Redis and three instances behind nginx on `localhost:8080`:

```bash
npm run stack:up
VITE_WS_URL=ws://localhost:8080 npm run dev -w @cce/web
npm run stack:logs   # follow all three instances
npm run stack:down
```

Open two tabs. nginx round-robins, so they land on different instances, and the
instance id in each server log line shows which.

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
| Cookie | A cookie is ambient: the browser attaches it to every upgrade, so any page that can reach the server can open an authenticated socket. Explicit beats automatic for a credential the client should have to present on purpose. |
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

---

## Phase 3b — three instances behind nginx

[`infra/docker-compose.yml`](infra/docker-compose.yml) runs Postgres, Redis and
three copies of the server behind nginx. It exists because a single instance
cannot demonstrate the thing Phase 3a built: with one server, the Redis path is
dead code that always agrees with itself.

### Round robin on purpose

nginx balances round robin rather than pinning each client to an instance with
`ip_hash`. Sticky sessions would be defensible — they save cold room loads, since
a reconnecting client finds its document already in memory. They are not used
here because relying on stickiness hides the failure it is papering over. If the
system only works while every client stays on one instance, then it does not work
when that instance restarts, and finding that out during a deploy is worse than
paying for a room load.

So the default path is the hard one: three clients on three instances, sharing a
document through Redis, and a reconnect that lands anywhere.

### The two lines that make WebSockets work

```nginx
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

Plus `proxy_http_version 1.1`, because the upgrade handshake does not exist in
1.0. Without these nginx answers the upgrade request as an ordinary GET and the
connection never becomes a socket — the most common way a proxy silently breaks
a WebSocket deployment.

The other one is `proxy_read_timeout`. It defaults to 60 seconds, and a
collaborative session is mostly silence, so an editor left open would be
disconnected roughly every minute. It is set to an hour here; the server's
30 second heartbeat is what keeps a genuinely idle connection from ever reaching
that.

### Shared secret, unshared identity

`AUTH_SECRET` is identical on all three instances, because a token issued by
whichever instance answered `POST /api/session` has to verify on whichever
instance the load balancer picks for the socket. `INSTANCE_ID` is the opposite:
it must differ, since it is how an instance recognises the echo of its own
publishes on the bus, and two instances sharing one would ignore each other's
traffic.

### Verified against the running stack

Three clients through nginx that landed on three different instances (confirmed
in the logs), all editing the same document:

```
b text  : "typed through nginx"
c text  : "typed through nginx"
a peers : [ 'heron', 'stoat' ]
converged: true "[b] typed{c} through nginx [a]"
a peers after b leaves: [ 'stoat' ]
```

And after `docker compose restart server-1 server-2 server-3`, a fresh client
reading the same document gets `"survives a rolling restart"` back from Postgres.

---

## Phase 3c — backpressure and rate limiting

Both of these come down to one rule, applied in both directions:

> **Presence can be dropped. Document updates cannot.**

A cursor position that never arrives is corrected by the next one a few hundred
milliseconds later. A document update that never arrives is a client that has
permanently diverged from everyone else, and it will look like a CRDT bug rather
than a network problem. So the two kinds of traffic get opposite treatment under
pressure, which is why they were kept on separate code paths from Phase 2c
onwards.

### Outbound: when a client cannot keep up

`bufferedAmount` is how much a socket has queued but not yet flushed to the
network. It grows when the reader is slower than the writer — a phone on a train,
a laptop that just woke up — and if nothing watches it, one slow client is a
memory leak the whole server pays for.

[`client.ts`](apps/server/src/ws/client.ts) has two send methods rather than one
with a flag, because the choice is not a parameter, it is which of two things you
are sending:

| buffered | `sendPresence` | `send` |
| --- | --- | --- |
| under 256 KB | sent | sent |
| over 256 KB | dropped, counted | sent |
| over 4 MB | dropped | **socket closed** |

Closing looks drastic and is the conservative option. There is no correct way to
silently skip a document update, but there is a correct way to disconnect: the
client reconnects, offers its state vector, and the server replies with exactly
what it missed. The machinery for that already exists because it is the same
machinery that handles a dropped wifi connection.

### Inbound: when a client sends too much

Each connection gets two token buckets — one weighed in bytes for document
traffic, one counted in frames for presence. Two rather than one so a client
whose cursor is moving constantly cannot starve its own edits.

Every document frame is charged at least 1 KB regardless of its real size, so a
flood of one-byte updates costs the budget what it actually costs the server in
syscalls and parsing, rather than nothing.

A token bucket rather than a fixed window: a fixed window lets a client spend its
entire allowance in the last millisecond of one window and again in the first
millisecond of the next, which is twice the intended rate delivered as a single
burst. Refill is computed from the clock when a frame arrives, so a thousand
connections cost a thousand numbers and no timers.

Over budget, the same rule applies as on the way out. Presence frames are
dropped. Document frames close the socket, because the client believes the edit
was delivered and the only state it can be left in honestly is one it will
resync from.

### The reconnect loop this opens

Rate limiting means the server can accept a socket and close it again
immediately, and the client's backoff reset the attempt counter on `open` — so a
client that tripped the limit would reconnect into the same wall twice a second,
forever. The fix is that a connection only counts as successful once it has
survived five seconds; anything shorter keeps the backoff climbing.

Worth stating because it is a general shape: an *open* is not a *success*, and
backoff that resets on the wrong event stops being backoff.

### Testing this

Backpressure is tested against a fake socket with a settable `bufferedAmount`,
which is the only way to reach these thresholds deterministically — a real slow
client is a timing test that passes on a fast machine. The rate limiter is tested
both ways: a client that floods gets close code 4003, and a client typing 200
characters as fast as the loop can run does not.

---

## Phase 3d — the numbers

[`infra/k6/editing.js`](infra/k6/editing.js). Each virtual user is one editing
session holding two sockets on the same document — a tab that types and a tab
that watches — so the metric that matters is measurable directly: **the time
from a keystroke leaving one socket to the resulting update arriving on the
other**, which is the whole round trip through nginx, the gateway, the room,
Redis, and back out through a second instance. About 90% of the pairs land on
different instances, so most samples include the cross-instance hop.

### Setup

Everything on one 12-core laptop: three server instances, nginx, Postgres,
Redis and the load generator all competing for the same cores. That makes these
numbers conservative for the server and useless as an absolute capacity figure
for real hardware. What they are good for is the shape of the curve and where the
cost actually sits.

### 2,000 sessions / 4,000 sockets

Ramped over two minutes, 45 second sessions, an edit every 400ms per session.

| | |
| --- | --- |
| peak concurrent connections | **3,895** |
| open rooms | 3,484 |
| edits delivered | 417,184 (**3,090/s**) |
| propagation median | 5 ms |
| propagation p95 | 16 ms |
| **propagation p99** | **30 ms** |
| propagation max | 163 ms |
| server ping RTT p99 | 22 ms |
| edits lost | 0 |
| failed connections | 2 of 8,598 |
| memory per instance | ~275 MB |

Two connections out of 8,598 were refused, at the point where the box was fully
saturated — every server container was over 100% of a core and Postgres was at
172%. That is the machine running out, not a limit in the design, but it is the
honest number and it is where this stops being a useful measurement.

### Where the time actually goes

Rerunning the identical load with the write debounce raised from 500ms to 5s and
compaction disabled — same 2,000 sessions, same 417,000 edits, 3,872 peak
connections:

| | 500ms debounce | 5s debounce |
| --- | --- | --- |
| propagation p95 | 16 ms | 11 ms |
| propagation p99 | 30 ms | 26 ms |
| ping RTT p99 | 22 ms | 17 ms |
| failed connections | 2 | 0 |
| Postgres CPU | 172% | 36% |
| per-instance CPU | 110–130% | 55–78% |

Persistence was costing about a third of the server CPU and five times the
database CPU, for roughly 15% of the p99. So the durability setting is a real
throughput dial, and the trade it makes is the one from Phase 2a stated in
different units: a longer debounce buys headroom and widens the window a hard
crash can lose.

The caveat matters more than the result. This workload is one document per user
— the worst possible shape for write amplification, because no two users' edits
ever batch into the same write. Real usage is many people per document, where a
single debounce window folds everyone's edits into one insert. These numbers are
a floor, not a forecast.

### Two bugs in the load test, both worth keeping

**nginx defaults to one worker process.** `worker_connections` counts both ends
of a proxied socket, so one worker at the 4096 I first set meant about 2,000
clients — and past that, connections were refused. The first run measured nginx
saying no. `worker_processes auto` and 16384 fixed it, and connection setup went
from a p95 of 40 seconds to 1.8 ms.

**The test was not repeatable, because the server is stateful.** The update pool
is pre-baked so that k6 does not have to run Yjs, which means every run sends
byte-identical updates. A Yjs update the server has already applied is a no-op
that produces no broadcast — so the second run against the same document ids
measured nothing at all, silently, and reported a flattering zero. Document ids
are now unique per run *and* per iteration, and an edit that does not come back
within five seconds is counted rather than quietly waited on forever.

The second one is the more useful lesson. The load test had a threshold that
passed, a metric that reported, and no errors — and it was measuring nothing.
Idempotency makes a replayed workload invisible rather than wrong.

---

## Deploying

One service. The server holds sockets open anyway, so it serves the built client
too, and the deployment is a single image on a single origin.

| Piece | Where | Why there |
| --- | --- | --- |
| Server + web app | Render | One long-lived process, one URL |
| Postgres | Neon | Optional. Without it documents live in memory |
| Redis | Upstash | Optional. Does nothing at one instance |

### Why one service and not two

An earlier version put the client on Vercel and the server on Render. Vercel
Functions do support WebSockets, but a function has a timeout — 60 seconds on
Hobby — and the socket dies with it. A collaborative session is a connection that
stays open for hours, so the server needs a long-lived process regardless.

Once that process exists, handing it the static bundle costs one file read and
removes an entire class of configuration: a second origin, the CORS between
them, `CORS_ORIGIN`, `VITE_WS_URL`, and the ordering problem where each deploy
needs the other's URL before it can be built. The client defaults to the origin
it was served from, which is the correct answer by construction.

The split is still the right shape at scale — a CDN in front of the bundle, the
server doing only sockets — but it is a change of hosting, not of code.

### Deploying it

New → Blueprint on Render, pointed at this repo. [`render.yaml`](render.yaml)
builds [`apps/server/Dockerfile`](apps/server/Dockerfile) from the workspace
root, which compiles the protocol package, the server and the web app into one
image. `AUTH_SECRET` is generated by Render. Nothing else is required.

| Variable | Required | Value |
| --- | --- | --- |
| `NODE_ENV` | set by the blueprint | `production` |
| `AUTH_SECRET` | generated by Render | identical on every instance |
| `DATABASE_URL` | no | the Neon URL, **with `?sslmode=require`** |
| `REDIS_URL` | no | the Upstash URL (`rediss://…`) |

In production the server **refuses to start** without `AUTH_SECRET`. Locally a
random per-process key is a convenience; deployed it means every restart
invalidates every token and no two instances agree on anything. That is worth
failing loudly at boot rather than discovering from a bug report.

### Adding durability

Without `DATABASE_URL` documents live only as long as the process — which, on a
free instance that spins down, is not very long. To keep them, apply the schema
once from anywhere that can reach the database:

```bash
DATABASE_URL='postgres://…?sslmode=require' npm run db:setup -w @cce/server
```

Run it locally rather than in the container: `db:setup` goes through `tsx`, and
the runtime image is built with `--omit=dev`. `sslmode` has to be in the URL —
`pg` reads it from there and will otherwise connect without TLS, which Neon
refuses. Every statement is `if not exists`, so re-running is harmless.

### What the free tier actually gives you

Worth stating plainly, because it changes what the deployed link demonstrates:

- **Render free instances spin down after 15 minutes of inactivity**, and the
  next request pays a 30–60 second cold start. The first person to open the app
  after a quiet night waits, and the client's reconnect backoff is what stops
  that from turning into a failed page load.
- **One instance.** The Redis relay is still wired in and still correct, but with
  a single instance it never has anyone to talk to. Phase 3 is the reason
  [`infra/docker-compose.yml`](infra/docker-compose.yml) exists: three instances
  behind nginx is a local setup, and it is where the multi-instance behaviour is
  demonstrated and measured.
- **Neon free tier suspends an idle database**, so the first document load after
  a pause is slower than the numbers in Phase 3d.

None of this is a design compromise; it is what the hosting costs nothing. The
deployed link is there to be clicked, and the docker-compose stack is there to be
measured.
