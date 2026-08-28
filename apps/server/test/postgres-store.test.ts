import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test } from 'node:test';
import * as Y from 'yjs';
import { PostgresDocumentStore } from '../src/persistence/index.js';
import { withServer } from './support/server.js';
import { TestClient, settle } from './support/y-client.js';

const connectionString = process.env.TEST_DATABASE_URL;

/**
 * Exercises the real storage layer. Skipped unless TEST_DATABASE_URL points at a
 * database with sql/schema.sql applied:
 *
 *   docker compose -f infra/docker-compose.yml up -d postgres
 *   TEST_DATABASE_URL=postgres://cce:cce@localhost:55432/cce npm test
 */
describe(
  'postgres document store',
  { skip: connectionString ? false : 'TEST_DATABASE_URL is not set' },
  () => {
    const store = new PostgresDocumentStore(connectionString ?? '');
    after(() => store.close());

    function update(text: string): Uint8Array {
      const doc = new Y.Doc();
      doc.getText('content').insert(0, text);
      return Y.encodeStateAsUpdate(doc);
    }

    test('replays the update log on top of the snapshot', async () => {
      const id = `test-${randomUUID()}`;

      assert.deepEqual(await store.load(id), { state: null, pendingUpdates: 0 });

      await store.append(id, update('one '));
      await store.append(id, update('two '));

      const loaded = await store.load(id);
      assert.equal(loaded.pendingUpdates, 2);

      const doc = new Y.Doc();
      Y.applyUpdate(doc, loaded.state!);
      assert.equal(doc.getText('content').length, 'one two '.length);
    });

    test('compaction folds the log away without changing the document', async () => {
      const id = `test-${randomUUID()}`;
      for (let i = 0; i < 5; i += 1) await store.append(id, update(`chunk${i} `));

      const before = await store.load(id);
      assert.equal(before.pendingUpdates, 5);

      assert.equal(await store.compact(id), 5);

      const after = await store.load(id);
      assert.equal(after.pendingUpdates, 0);

      // Same document, one row instead of five.
      const rebuilt = new Y.Doc();
      Y.applyUpdate(rebuilt, after.state!);
      const original = new Y.Doc();
      Y.applyUpdate(original, before.state!);
      assert.equal(rebuilt.getText('content').toString(), original.getText('content').toString());
    });

    test('edits made over a socket are still there after a restart', async () => {
      const id = `test-${randomUUID()}`;

      await withServer(store, async (url) => {
        const author = await TestClient.connect(`${url}/doc/${id}`);
        try {
          await settle();
          author.insert(0, 'stored in postgres');
        } finally {
          author.close();
        }
      });

      await withServer(store, async (url) => {
        const reader = await TestClient.connect(`${url}/doc/${id}`);
        try {
          await settle();
          assert.equal(reader.text, 'stored in postgres');
        } finally {
          reader.close();
        }
      });
    });
  },
);
