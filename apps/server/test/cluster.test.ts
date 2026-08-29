import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { DocumentStore } from '../src/persistence/index.js';
import { MemoryDocumentStore } from '../src/persistence/index.js';
import { MemoryDocumentBus } from './support/memory-bus.js';
import { withCluster } from './support/server.js';
import { TestClient, settle, testToken } from './support/y-client.js';

/**
 * A store that keeps nothing. Used where a test needs to prove something
 * travelled over the bus: if the document could have come back from storage,
 * the test would pass either way.
 */
const forgetful: DocumentStore = {
  async load() {
    return { state: null, pendingUpdates: 0 };
  },
  async append() {},
  async compact() {
    return 0;
  },
  async close() {},
};

describe('cross-instance sync', () => {
  it('delivers an edit made on one instance to a client on another', async () => {
    const bus = new MemoryDocumentBus();

    await withCluster(new MemoryDocumentStore(), bus, 3, async ([first, , third]) => {
      const a = await TestClient.connect(`${first}/doc/relay`, testToken('a'));
      const c = await TestClient.connect(`${third}/doc/relay`, testToken('c'));
      after(() => {
        a.close();
        c.close();
      });

      a.insert(0, 'typed on the first instance');
      await settle();

      assert.equal(c.text, 'typed on the first instance');
    });
  });

  it('converges concurrent edits made on different instances', async () => {
    const bus = new MemoryDocumentBus();

    await withCluster(new MemoryDocumentStore(), bus, 2, async ([first, second]) => {
      const a = await TestClient.connect(`${first}/doc/concurrent`, testToken('a'));
      const b = await TestClient.connect(`${second}/doc/concurrent`, testToken('b'));
      after(() => {
        a.close();
        b.close();
      });

      a.insert(0, 'seed ');
      await settle();

      // Both clients now insert at the same offset without seeing each other.
      a.insert(5, 'left');
      b.insert(5, 'right');
      await settle();

      assert.equal(a.text, b.text);
      assert.ok(a.text.includes('left') && a.text.includes('right'));
    });
  });

  it('carries presence across instances and clears it on disconnect', async () => {
    const bus = new MemoryDocumentBus();

    await withCluster(new MemoryDocumentStore(), bus, 2, async ([first, second]) => {
      const a = await TestClient.connect(`${first}/doc/presence`, testToken('a'));
      const b = await TestClient.connect(`${second}/doc/presence`, testToken('b'));
      after(() => {
        a.close();
        b.close();
      });

      a.setPresence('otter');
      b.setPresence('heron');
      await settle();

      assert.deepEqual(a.peers(), ['heron']);
      assert.deepEqual(b.peers(), ['otter']);

      a.disconnect();
      await settle();

      // The instance a was connected to has to publish the removal, or the
      // cursor sits on b's screen until the awareness timeout expires.
      assert.deepEqual(b.peers(), []);
    });
  });

  it('asks its peers for state the store cannot have yet', async () => {
    const bus = new MemoryDocumentBus();

    await withCluster(forgetful, bus, 2, async ([first, second]) => {
      const a = await TestClient.connect(`${first}/doc/handoff`, testToken('a'));
      after(() => a.close());

      a.insert(0, 'written but not yet stored');
      await settle();

      // The second instance opens the document cold. Its read returns nothing,
      // so everything it ends up with came from the first instance answering a
      // state request.
      const b = await TestClient.connect(`${second}/doc/handoff`, testToken('b'));
      after(() => b.close());
      await settle();

      assert.equal(b.text, 'written but not yet stored');
    });
  });
});
