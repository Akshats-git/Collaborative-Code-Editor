import * as Y from 'yjs';
import type { DocumentStore, LoadedDocument } from './store.js';

interface Entry {
  snapshot: Uint8Array | null;
  updates: Uint8Array[];
}

/**
 * The same contract as the Postgres store, kept in process memory, so that
 * `npm run dev` and the test suite need no database. It is not a cache in front
 * of Postgres: with DATABASE_URL unset the server has no durability at all, and
 * says so on startup.
 */
export class MemoryDocumentStore implements DocumentStore {
  private readonly documents = new Map<string, Entry>();

  async load(documentId: string): Promise<LoadedDocument> {
    const entry = this.documents.get(documentId);
    if (!entry || (!entry.snapshot && entry.updates.length === 0)) {
      return { state: null, pendingUpdates: 0 };
    }

    const parts = entry.snapshot ? [entry.snapshot, ...entry.updates] : [...entry.updates];
    return {
      state: parts.length === 1 ? parts[0]! : Y.mergeUpdates(parts),
      pendingUpdates: entry.updates.length,
    };
  }

  async append(documentId: string, update: Uint8Array): Promise<void> {
    const entry = this.documents.get(documentId) ?? { snapshot: null, updates: [] };
    entry.updates.push(update);
    this.documents.set(documentId, entry);
  }

  async compact(documentId: string): Promise<number> {
    const entry = this.documents.get(documentId);
    if (!entry || entry.updates.length === 0) return 0;

    const folded = entry.updates.length;
    const parts = entry.snapshot ? [entry.snapshot, ...entry.updates] : entry.updates;
    entry.snapshot = Y.mergeUpdates(parts);
    entry.updates = [];
    return folded;
  }

  async close(): Promise<void> {
    // Nothing to release. The map lives as long as the process, which is what
    // lets a test restart the server around a store and still find its documents.
  }
}
