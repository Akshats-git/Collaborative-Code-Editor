import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryDocumentStore } from '../src/persistence/index.js';
import { withServer } from './support/server.js';
import { TestClient, settle } from './support/y-client.js';

test('a document survives the server restarting', async () => {
  // One store, two server lifetimes: the same shape as a deploy, or a Render
  // instance waking back up.
  const store = new MemoryDocumentStore();

  await withServer(store, async (url) => {
    const author = await TestClient.connect(`${url}/doc/durable`);
    try {
      await settle();
      author.insert(0, 'written before the restart');
    } finally {
      author.close();
    }
    // Leaving this block shuts the server down gracefully, which flushes the
    // pending batch rather than waiting out its debounce.
  });

  await withServer(store, async (url) => {
    const reader = await TestClient.connect(`${url}/doc/durable`);
    try {
      await settle();
      assert.equal(reader.text, 'written before the restart');
    } finally {
      reader.close();
    }
  });
});

test('reconnecting after a dropout costs a delta, not the document', async () => {
  await withServer(new MemoryDocumentStore(), async (url) => {
    const author = await TestClient.connect(`${url}/doc/delta`);
    const peer = await TestClient.connect(`${url}/doc/delta`);

    try {
      await settle();
      author.insert(0, 'x'.repeat(50_000));
      await settle();

      // A client that has just joined has to be sent the whole thing.
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
    } finally {
      author.close();
      peer.close();
    }
  });
});
