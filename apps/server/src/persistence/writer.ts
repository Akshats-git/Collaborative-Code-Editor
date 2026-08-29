import * as Y from 'yjs';
import { logger } from '../logger.js';
import type { DocumentStore, UpdateSink } from './store.js';

export interface WriterOptions {
  /** Quiet period after the last update before the batch is written. */
  debounceMs: number;
  /** Write immediately once a batch reaches this size, however recent it is. */
  maxBatchBytes: number;
  /** Fold the update log into a new snapshot after this many appended rows. */
  compactAfter: number;
}

/**
 * Batches a room's updates on their way to the store, so a burst of typing
 * becomes one row instead of one insert per character per editor.
 *
 * A hard crash loses at most `debounceMs` of edits. SIGTERM and the last client
 * leaving both flush first, so an ordinary restart loses nothing.
 */
export class DocumentWriter implements UpdateSink {
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  /** Serialises writes so two flushes cannot interleave on the same document. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly documentId: string,
    private readonly store: DocumentStore,
    private readonly options: WriterOptions,
    private rowsSinceSnapshot: number,
  ) {}

  record(update: Uint8Array): void {
    this.pending.push(update);
    this.pendingBytes += update.byteLength;

    if (this.pendingBytes >= this.options.maxBatchBytes) {
      void this.flush();
      return;
    }

    this.schedule();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  private flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending.length === 0) return this.queue;

    const batch = this.pending;
    this.pending = [];
    this.pendingBytes = 0;

    this.queue = this.queue.then(() => this.write(batch));
    return this.queue;
  }

  /**
   * The timer is unref'd so a pending batch cannot hold the process open. The
   * shutdown path flushes explicitly rather than relying on it firing.
   */
  private schedule(): void {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => void this.flush(), this.options.debounceMs);
    this.timer.unref();
  }

  private async write(batch: Uint8Array[]): Promise<void> {
    const merged = batch.length === 1 ? batch[0]! : Y.mergeUpdates(batch);

    try {
      await this.store.append(this.documentId, merged);
      this.rowsSinceSnapshot += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (this.closed) {
        // Shutting down and the store is unreachable. This is data loss and it
        // should be loud, but retrying here would hang the process.
        logger.error('dropping updates, store unreachable during shutdown', {
          documentId: this.documentId,
          bytes: merged.byteLength,
          error: message,
        });
        return;
      }

      logger.error('failed to persist update, will retry', {
        documentId: this.documentId,
        bytes: merged.byteLength,
        error: message,
      });

      // Safe to push onto the end rather than the front. Yjs updates commute,
      // so the batch does not need to keep its position in the queue.
      this.pending.push(merged);
      this.pendingBytes += merged.byteLength;
      this.schedule();
      return;
    }

    if (this.rowsSinceSnapshot < this.options.compactAfter) return;

    try {
      await this.store.compact(this.documentId);
      this.rowsSinceSnapshot = 0;
    } catch (error) {
      // Compaction is an optimisation. Failing it costs read performance, not data.
      logger.warn('compaction failed', {
        documentId: this.documentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
