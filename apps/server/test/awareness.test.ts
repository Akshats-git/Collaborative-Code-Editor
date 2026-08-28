import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';
import { MemoryDocumentStore } from '../src/persistence/index.js';
import { TestClient, settle } from './support/y-client.js';

// Deliberately shared with the durability test below: awareness must not appear
// in anything the store hands back.
const store = new MemoryDocumentStore();
const app = createApp({ store });
let url = '';

before(async () => {
  const port = await app.listen(0);
  url = `ws://127.0.0.1:${port}/doc/presence`;
});

after(() => app.close());

test('presence propagates to everyone in the room', async () => {
  const alice = await TestClient.connect(url);
  const bob = await TestClient.connect(url);
  await settle();

  alice.setPresence('alice');
  bob.setPresence('bob');
  await settle();

  assert.deepEqual(alice.peers(), ['bob']);
  assert.deepEqual(bob.peers(), ['alice']);

  alice.close();
  bob.close();
});

test('a disconnect clears that user from everyone else', async () => {
  const alice = await TestClient.connect(url);
  const bob = await TestClient.connect(url);
  await settle();
  alice.setPresence('alice');
  bob.setPresence('bob');
  await settle();

  alice.close();
  await settle();

  // Nobody should be left staring at a cursor that is not there any more.
  assert.deepEqual(bob.peers(), []);

  bob.close();
});

test('presence is never written to the store', async () => {
  const alice = await TestClient.connect(url);
  await settle();
  alice.setPresence('alice');
  alice.insert(0, 'text is durable');
  await settle();
  alice.close();
  await settle(600);

  const loaded = await store.load('presence');
  const reader = await TestClient.connect(url);
  await settle();

  assert.notEqual(loaded.state, null);
  assert.equal(reader.text, 'text is durable');
  assert.deepEqual(reader.peers(), []);

  reader.close();
});
