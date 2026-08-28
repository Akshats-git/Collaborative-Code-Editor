import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { MemoryDocumentStore } from '../src/persistence/index.js';
import { TestClient, settle } from './support/y-client.js';

test('a document survives the server restarting', async () => {
  // One store, two server lifetimes: the same shape as a deploy or a Render
  // instance waking back up.
  const store = new MemoryDocumentStore();

  const first = createApp({ store });
  const firstPort = await first.listen(0);
  const author = await TestClient.connect(`ws://127.0.0.1:${firstPort}/doc/durable`);
  await settle();
  author.insert(0, 'written before the restart');
  author.close();

  // close() is the graceful path, so the pending batch is flushed rather than
  // waiting out its debounce.
  await first.close();

  const second = createApp({ store });
  const secondPort = await second.listen(0);
  const reader = await TestClient.connect(`ws://127.0.0.1:${secondPort}/doc/durable`);
  await settle();

  assert.equal(reader.text, 'written before the restart');

  reader.close();
  await second.close();
});

test('reconnecting after a dropout costs a delta, not the document', async () => {
  const app = createApp({ store: new MemoryDocumentStore() });
  const port = await app.listen(0);
  const url = `ws://127.0.0.1:${port}/doc/delta`;

  const author = await TestClient.connect(url);
  await settle();
  author.insert(0, 'x'.repeat(50_000));
  await settle();

  // A fresh client has to be sent the whole thing.
  const peer = await TestClient.connect(url);
  await settle();
  const fullFetch = peer.bytesReceived;
  assert.ok(fullFetch > 40_000, `expected a full document fetch, got ${fullFetch} bytes`);

  // Go offline, miss some edits, come back.
  peer.disconnect();
  await settle();
  author.insert(0, 'edited while away. ');
  await settle();

  peer.bytesReceived = 0;
  await peer.open();
  await settle();

  assert.ok(peer.text.startsWith('edited while away. '));
  assert.ok(
    peer.bytesReceived < 2_000,
    `expected a delta, got ${peer.bytesReceived} bytes for a ${fullFetch} byte document`,
  );

  author.close();
  peer.close();
  await app.close();
});
