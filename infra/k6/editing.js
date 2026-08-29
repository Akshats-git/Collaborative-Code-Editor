/**
 * Measures what a collaborative editing session actually costs the server.
 *
 *   k6 run infra/k6/editing.js
 *   k6 run -e TARGET_VUS=1000 -e BASE=http://localhost:8080 infra/k6/editing.js
 *
 * Each virtual user is one editing session with two connections open on the
 * same document: a tab that types and a tab that watches. That is what makes
 * the interesting number measurable, which is the time from a keystroke leaving
 * one socket to the resulting update arriving on the other. Behind nginx the
 * two sockets usually land on different instances, so it includes the
 * cross-instance hop.
 *
 * Every VU gets its own document. That isolates the measurement, and it is
 * deliberately the expensive shape for the server: one room, one Y.Doc and one
 * Redis subscription per user, rather than a handful of crowded rooms.
 */
import http from 'k6/http';
import encoding from 'k6/encoding';
import { Counter, Trend } from 'k6/metrics';
import { WebSocket } from 'k6/experimental/websockets';

const BASE = __ENV.BASE || 'http://localhost:8080';
const WS_BASE = BASE.replace(/^http/, 'ws');
const TARGET_VUS = Number(__ENV.TARGET_VUS || 300);
const SESSION_SECONDS = Number(__ENV.SESSION_SECONDS || 40);
/** Roughly a keystroke every 400ms, which is a brisk but human typing speed. */
const EDIT_INTERVAL_MS = Number(__ENV.EDIT_INTERVAL_MS || 400);
/** How long to wait for an edit to come back before giving up on it. */
const EDIT_TIMEOUT_MS = Number(__ENV.EDIT_TIMEOUT_MS || 5000);

const MessageType = { Sync: 0, Awareness: 1, Ping: 2, Pong: 3, Auth: 4 };

const updates = JSON.parse(open('./updates.json'));

/** Keystroke on one socket to update delivered on the other. */
const propagation = new Trend('edit_propagation', true);
/** Application-level ping to pong. Shows when the event loop is saturated. */
const serverRtt = new Trend('server_rtt', true);
const edits = new Counter('edits_delivered');
const failures = new Counter('connect_failures');
/** Edits that never came back. Zero on a healthy run; the first thing to move
 *  when the server is past what it can carry. */
const timeouts = new Counter('edit_timeouts');

export const options = {
  // p99 is the number that matters here: an editor that is fast on average and
  // occasionally stalls for a second is the one people complain about.
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    editing: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '20s', target: Math.round(TARGET_VUS / 3) },
        { duration: '20s', target: Math.round((TARGET_VUS * 2) / 3) },
        { duration: '60s', target: TARGET_VUS },
        { duration: '20s', target: 0 },
      ],
      gracefulRampDown: '15s',
    },
  },
  thresholds: {
    // A keystroke should feel immediate. 250ms at p99 is the bar; above that,
    // collaborators notice each other lagging.
    edit_propagation: ['p(95)<150', 'p(99)<250'],
    server_rtt: ['p(99)<250'],
    connect_failures: ['count<1'],
    edit_timeouts: ['count<1'],
  },
};

/**
 * One token for the whole run. The session endpoint is not what is under test,
 * and issuing thousands of them would measure Postgres-free HMAC signing rather
 * than the WebSocket path.
 */
export function setup() {
  const res = http.post(
    `${BASE}/api/session`,
    JSON.stringify({ name: 'load' }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  if (res.status !== 200) throw new Error(`could not get a session token: ${res.status}`);

  // A fresh set of document ids per run. The update pool is pre-baked and so is
  // identical every run, and a Yjs update the server has already applied is a
  // no-op that produces no broadcast. Reusing document ids would make the
  // second run of this script silently measure nothing.
  return { token: res.json('token'), runId: __ENV.RUN_ID || String(Date.now()) };
}

function authFrame(token) {
  const bytes = [MessageType.Auth];
  for (let i = 0; i < token.length; i += 1) bytes.push(token.charCodeAt(i));
  return new Uint8Array(bytes).buffer;
}

function syncFrame(base64) {
  const payload = new Uint8Array(encoding.b64decode(base64));
  const frame = new Uint8Array(payload.length + 1);
  frame[0] = MessageType.Sync;
  frame.set(payload, 1);
  return frame.buffer;
}

const PING = new Uint8Array([MessageType.Ping]).buffer;

export default function (data) {
  // Unique per run *and* per iteration. The run id keeps a second `k6 run` from
  // replaying updates the server already stored; `__ITER` does the same for a
  // VU's second session, which is the same bug one scope down.
  const documentId = `load-${data.runId}-${__VU}-${__ITER}`;
  const url = `${WS_BASE}/doc/${documentId}`;

  const writer = new WebSocket(url);
  const reader = new WebSocket(url);
  writer.binaryType = 'arraybuffer';
  reader.binaryType = 'arraybuffer';

  let sentAt = null;
  let cursor = __VU % updates.length;
  let editTimer = null;
  let pingTimer = null;
  let pingSentAt = null;
  let readerReady = false;

  const stop = () => {
    if (editTimer !== null) clearInterval(editTimer);
    if (pingTimer !== null) clearInterval(pingTimer);
    writer.close();
    reader.close();
  };

  writer.onerror = () => failures.add(1);
  reader.onerror = () => failures.add(1);

  // Registered before anything is opened, not inside `onopen`. k6 keeps an
  // iteration alive while the event loop has work, so hanging the session
  // timeout off a successful connection means a failed connection ends the
  // iteration immediately and the VU starts another one. A load test that
  // reacts to refused connections by reconnecting harder measures the storm it
  // created rather than the server.
  setTimeout(stop, SESSION_SECONDS * 1000);

  writer.onopen = () => {
    writer.send(authFrame(data.token));

    // A second of quiet first: the reader's own sync handshake is still in
    // flight, and a handshake frame counted as an edit would flatter the
    // numbers.
    setTimeout(() => {
      editTimer = setInterval(() => {
        // Nothing to measure until the reader is actually in the room.
        if (!readerReady) return;
        if (sentAt !== null) {
          // Still waiting. Past the timeout, write it off and carry on, so one
          // lost edit does not silently stop the VU from measuring anything
          // else for the rest of the session.
          if (Date.now() - sentAt > EDIT_TIMEOUT_MS) {
            timeouts.add(1);
            sentAt = null;
          }
          return;
        }
        sentAt = Date.now();
        cursor = (cursor + 1) % updates.length;
        writer.send(syncFrame(updates[cursor]));
      }, EDIT_INTERVAL_MS);

      pingTimer = setInterval(() => {
        if (pingSentAt !== null) return;
        pingSentAt = Date.now();
        writer.send(PING);
      }, 5000);
    }, 1000);
  };

  writer.onmessage = (event) => {
    const frame = new Uint8Array(event.data);
    if (frame[0] === MessageType.Pong && pingSentAt !== null) {
      serverRtt.add(Date.now() - pingSentAt);
      pingSentAt = null;
    }
  };

  reader.onopen = () => {
    reader.send(authFrame(data.token));
  };

  reader.onmessage = () => {
    if (!readerReady) {
      // The first frame is the server's sync step 1, sent the moment this
      // socket joins the room, so it is the exact point at which broadcasts
      // start arriving. A timer here would be a guess, and under load a wrong
      // one: every session's first edit would be sent into a room the reader
      // had not joined yet and recorded as lost.
      readerReady = true;
      return;
    }
    if (sentAt === null) return;
    propagation.add(Date.now() - sentAt);
    edits.add(1);
    sentAt = null;
  };
}
