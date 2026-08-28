export interface LoadedDocument {
  /**
   * Snapshot and update log merged into a single Yjs update, or null if the
   * document has never been written to.
   */
  state: Uint8Array | null;
  /** Rows sitting on top of the snapshot. Drives the compaction threshold. */
  pendingUpdates: number;
}

export interface DocumentStore {
  load(documentId: string): Promise<LoadedDocument>;
  append(documentId: string, update: Uint8Array): Promise<void>;
  /** Folds the update log back into the snapshot. Returns rows removed. */
  compact(documentId: string): Promise<number>;
  close(): Promise<void>;
}

/**
 * Receives every update a room produces and is responsible for getting it into
 * the store. Rooms depend on this rather than on the store directly, so a room
 * can be tested without any persistence at all.
 */
export interface UpdateSink {
  record(update: Uint8Array): void;
  flush(): Promise<void>;
}

export const NO_PERSISTENCE: UpdateSink = {
  record() {},
  async flush() {},
};
