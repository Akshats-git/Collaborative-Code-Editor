import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { RedisDocumentBus, type DocumentBus } from '../src/cluster/index.js';
import { MemoryDocumentStore } from '../src/persistence/index.js';
import { withCluster } from './support/server.js';
import { TestClient, settle, testToken } from './support/y-client.js';

const url = process.env['TEST_REDIS_URL'];

/**
 * The same scenarios as `cluster.test.ts`, but over a real broker.
 *
 * Worth having separately: the in-process bus proves the room logic is right,
 * this proves the framing survives a round trip through Redis and that we
 * correctly ignore the copy of every publish Redis hands back to us.
 */
describe('redis bus', { skip: url ? false : 'TEST_REDIS_URL is not set' }, () => {
  const opened: DocumentBus[] = [];
  const cluster = {
    endpoint(instanceId: string): DocumentBus {
      const bus = new RedisDocumentBus(url as string, instanceId);
      opened.push(bus);
      return bus;
    },
  };

  after(async () => {
    await Promise.all(opened.map((bus) => bus.close()));
  });

  it('relays edits between instances', async () => {
    const documentId = `relay-${randomUUID()}`;

    await withCluster(new MemoryDocumentStore(), cluster, 2, async ([first, second]) => {
      const a = await TestClient.connect(`${first}/doc/${documentId}`, testToken('a'));
      const b = await TestClient.connect(`${second}/doc/${documentId}`, testToken('b'));
      after(() => {
        a.close();
        b.close();
      });
      await settle();

      a.insert(0, 'over redis');
      await settle();
      assert.equal(b.text, 'over redis');

      b.insert(10, ' and back');
      await settle();
      assert.equal(a.text, 'over redis and back');
    });
  });

  it('keeps documents on separate channels', async () => {
    const one = `alpha-${randomUUID()}`;
    const two = `beta-${randomUUID()}`;

    await withCluster(new MemoryDocumentStore(), cluster, 2, async ([first, second]) => {
      const a = await TestClient.connect(`${first}/doc/${one}`, testToken('a'));
      const b = await TestClient.connect(`${second}/doc/${two}`, testToken('b'));
      after(() => {
        a.close();
        b.close();
      });

      a.insert(0, 'only in alpha');
      await settle();

      assert.equal(b.text, '');
    });
  });
});
