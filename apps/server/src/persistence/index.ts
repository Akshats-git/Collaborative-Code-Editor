import { config } from '../config.js';
import { logger } from '../logger.js';
import { MemoryDocumentStore } from './memory-store.js';
import { PostgresDocumentStore } from './postgres-store.js';
import type { DocumentStore } from './store.js';

export * from './store.js';
export { DocumentWriter, type WriterOptions } from './writer.js';
export { MemoryDocumentStore } from './memory-store.js';
export { PostgresDocumentStore } from './postgres-store.js';

export function createDocumentStore(): DocumentStore {
  if (!config.databaseUrl) {
    logger.warn('DATABASE_URL is not set, documents will not survive a restart');
    return new MemoryDocumentStore();
  }
  return new PostgresDocumentStore(config.databaseUrl);
}
