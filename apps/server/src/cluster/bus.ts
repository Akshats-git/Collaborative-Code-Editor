import type { BusKindValue, BusMessage } from './messages.js';

export type BusListener = (message: BusMessage) => void;

/**
 * Relays document and awareness traffic between server instances. One channel
 * per document, so an instance holding three does not decode traffic for the
 * other thousand.
 */
export interface DocumentBus {
  subscribe(documentId: string, listener: BusListener): Promise<void>;
  unsubscribe(documentId: string): Promise<void>;
  /** Fire and forget. See `RedisDocumentBus` for what an unreachable broker costs. */
  publish(documentId: string, kind: BusKindValue, payload: Uint8Array): void;
  close(): Promise<void>;
}

/** Used when no broker is configured. Every room is then local to one process. */
export const NO_BUS: DocumentBus = {
  async subscribe() {},
  async unsubscribe() {},
  publish() {},
  async close() {},
};
