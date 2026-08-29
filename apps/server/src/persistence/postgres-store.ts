import pg from 'pg';
import * as Y from 'yjs';
import { logger } from '../logger.js';
import type { DocumentStore, LoadedDocument } from './store.js';

/**
 * Snapshot plus append-only log. One row per update keeps writes cheap and
 * contention free, since appending never reads, never locks and never conflicts
 * with another instance. The cost is that replaying a long-lived document means
 * reading thousands of rows, which is what compaction fixes.
 */
export class PostgresDocumentStore implements DocumentStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      max: 10,
      // Neon and most hosted Postgres close idle connections on their side.
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    this.pool.on('error', (error) => {
      logger.error('postgres pool error', { error: error.message });
    });
  }

  async load(documentId: string): Promise<LoadedDocument> {
    const client = await this.pool.connect();
    try {
      const snapshot = await client.query<{ state: Buffer; through_seq: string }>(
        'select state, through_seq from document_snapshots where document_id = $1',
        [documentId],
      );

      const base = snapshot.rows[0];
      const tail = await client.query<{ payload: Buffer }>(
        'select payload from document_updates where document_id = $1 and seq > $2 order by seq',
        [documentId, base?.through_seq ?? '0'],
      );

      if (!base && tail.rows.length === 0) {
        return { state: null, pendingUpdates: 0 };
      }

      const parts: Uint8Array[] = [];
      if (base) parts.push(new Uint8Array(base.state));
      for (const row of tail.rows) parts.push(new Uint8Array(row.payload));

      return {
        // Yjs updates are commutative and idempotent, so merging them in
        // sequence order gives the same document however they interleaved.
        state: parts.length === 1 ? parts[0]! : Y.mergeUpdates(parts),
        pendingUpdates: tail.rows.length,
      };
    } finally {
      client.release();
    }
  }

  async append(documentId: string, update: Uint8Array): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('insert into documents (id) values ($1) on conflict (id) do nothing', [
        documentId,
      ]);
      await client.query('insert into document_updates (document_id, payload) values ($1, $2)', [
        documentId,
        Buffer.from(update),
      ]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async compact(documentId: string): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');

      // Only one instance should compact a given document at a time. The lock
      // is released when the transaction ends, however it ends.
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [documentId]);

      const cutoff = await client.query<{ through_seq: string | null }>(
        'select max(seq) as through_seq from document_updates where document_id = $1',
        [documentId],
      );
      const throughSeq = cutoff.rows[0]?.through_seq;
      if (throughSeq === null || throughSeq === undefined) {
        await client.query('commit');
        return 0;
      }

      // Rebuilt from what is in the database rather than from the in-memory
      // document, because another instance may have appended updates this
      // process has never seen and those must survive the truncation.
      const snapshot = await client.query<{ state: Buffer }>(
        'select state from document_snapshots where document_id = $1',
        [documentId],
      );
      const tail = await client.query<{ payload: Buffer }>(
        'select payload from document_updates where document_id = $1 and seq <= $2 order by seq',
        [documentId, throughSeq],
      );

      const parts: Uint8Array[] = [];
      if (snapshot.rows[0]) parts.push(new Uint8Array(snapshot.rows[0].state));
      for (const row of tail.rows) parts.push(new Uint8Array(row.payload));

      const merged = Y.mergeUpdates(parts);

      await client.query(
        `insert into document_snapshots (document_id, state, through_seq, created_at)
         values ($1, $2, $3, now())
         on conflict (document_id)
         do update set state = excluded.state,
                       through_seq = excluded.through_seq,
                       created_at = excluded.created_at`,
        [documentId, Buffer.from(merged), throughSeq],
      );

      const deleted = await client.query(
        'delete from document_updates where document_id = $1 and seq <= $2',
        [documentId, throughSeq],
      );

      await client.query('commit');
      logger.info('compacted document', {
        documentId,
        foldedUpdates: deleted.rowCount ?? 0,
        snapshotBytes: merged.byteLength,
      });
      return deleted.rowCount ?? 0;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
