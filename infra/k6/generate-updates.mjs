/**
 * Pre-bakes a pool of Yjs update frames for the load test.
 *
 * k6 runs on a JavaScript engine that is not Node, so bundling Yjs into the
 * load script is more trouble than it is worth. Generating the frames here
 * instead keeps the script to plain array manipulation, and means the load
 * generator is not spending its own CPU on CRDT encoding while it is supposed
 * to be measuring the server.
 *
 *   node infra/k6/generate-updates.mjs
 */
import { writeFileSync } from 'node:fs';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

// Comfortably more than one session can spend. Running past the end of the
// pool would start replaying updates the server has already applied, which are
// no-ops that produce no broadcast -- see the run id in editing.js.
const COUNT = 2000;

const frames = [];
for (let i = 0; i < COUNT; i += 1) {
  // A fresh document each time, so every update carries a different client ID
  // and none of them is a no-op for a server that has already seen the others.
  const doc = new Y.Doc();
  let update;
  doc.on('update', (bytes) => {
    update = bytes;
  });
  doc.getText('content').insert(0, 'x');

  const encoder = encoding.createEncoder();
  syncProtocol.writeUpdate(encoder, update);
  frames.push(Buffer.from(encoding.toUint8Array(encoder)).toString('base64'));
  doc.destroy();
}

writeFileSync(
  new URL('updates.json', import.meta.url),
  `${JSON.stringify(frames, null, 0)}\n`,
);
console.log(`wrote ${frames.length} sync frames`);
