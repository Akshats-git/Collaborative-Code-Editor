import { Redis } from 'ioredis';
import { logger } from '../logger.js';
import type { BusListener, DocumentBus } from './bus.js';
import { decodeBusMessage, encodeBusMessage, type BusKindValue } from './messages.js';

const CHANNEL_PREFIX = 'cce:doc:';

/** How often a repeating connection error is allowed to reach the log. */
const ERROR_LOG_INTERVAL_MS = 10_000;

/**
 * Fans document traffic out across instances over Redis pub/sub.
 *
 * Two connections, because a Redis client in subscriber mode may not issue
 * ordinary commands -- one holds the subscriptions, the other publishes.
 *
 * Redis is treated as a relay, never as a source of truth. Nothing here is
 * stored and nothing is replayed: if the broker is unreachable, each instance
 * keeps serving the clients connected to it and only cross-instance edits stop
 * flowing. That is a real degradation, but it is a partition rather than an
 * outage, and it heals on its own -- see `Room`'s state request, which every
 * instance issues when it reopens a document.
 */
export class RedisDocumentBus implements DocumentBus {
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly listeners = new Map<string, BusListener>();
  private lastErrorLoggedAt = 0;

  constructor(
    url: string,
    private readonly instanceId: string,
  ) {
    // Fail publishes fast instead of queueing them: a queued document update is
    // one that arrives out of order minutes later, which is worse than one that
    // never arrives, since the room is converged again by then.
    this.publisher = new Redis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
    // The subscriber keeps its queue: ioredis replays SUBSCRIBE on reconnect, so
    // a room that outlives an outage gets its channel back without our help.
    this.subscriber = new Redis(url);

    this.publisher.on('error', (error) => this.onError('publisher', error));
    this.subscriber.on('error', (error) => this.onError('subscriber', error));
    this.subscriber.on('ready', () => logger.info('redis subscriber ready'));

    this.subscriber.on('messageBuffer', (channel, message) => {
      this.onMessage(channel.toString('utf8'), message);
    });
  }

  async subscribe(documentId: string, listener: BusListener): Promise<void> {
    const channel = CHANNEL_PREFIX + documentId;
    this.listeners.set(channel, listener);
    try {
      await this.subscriber.subscribe(channel);
    } catch (error) {
      // Not fatal: the room still works locally, and ioredis subscribes for us
      // once the connection is back.
      this.onError('subscribe', error);
    }
  }

  async unsubscribe(documentId: string): Promise<void> {
    const channel = CHANNEL_PREFIX + documentId;
    this.listeners.delete(channel);
    try {
      await this.subscriber.unsubscribe(channel);
    } catch (error) {
      this.onError('unsubscribe', error);
    }
  }

  publish(documentId: string, kind: BusKindValue, payload: Uint8Array): void {
    const frame = encodeBusMessage({ kind, origin: this.instanceId, payload });
    this.publisher
      .publish(CHANNEL_PREFIX + documentId, Buffer.from(frame))
      .catch((error: unknown) => this.onError('publish', error));
  }

  async close(): Promise<void> {
    this.listeners.clear();
    await Promise.allSettled([shutdown(this.publisher), shutdown(this.subscriber)]);
  }

  private onMessage(channel: string, frame: Buffer): void {
    const listener = this.listeners.get(channel);
    if (!listener) return;

    let message;
    try {
      message = decodeBusMessage(frame);
    } catch (error) {
      logger.warn('discarding malformed bus message', { channel, error: String(error) });
      return;
    }

    // Redis delivers our own publishes back to us. Applying them would be
    // harmless -- Yjs updates are idempotent -- but it doubles the work.
    if (message.origin === this.instanceId) return;

    listener(message);
  }

  private onError(source: string, error: unknown): void {
    // A broker that is down produces one of these per reconnect attempt, which
    // is enough to bury every other line in the log.
    const now = Date.now();
    if (now - this.lastErrorLoggedAt < ERROR_LOG_INTERVAL_MS) return;
    this.lastErrorLoggedAt = now;
    logger.warn('redis unavailable, running without cross-instance sync', {
      source,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * QUIT drains anything in flight, but it only completes while we are connected:
 * on a client that never reached the broker it sits in the offline queue
 * forever. `disconnect` is the half that actually stops the reconnect loop, and
 * without it a process that started with Redis down never exits.
 */
async function shutdown(client: Redis): Promise<void> {
  if (client.status === 'ready') await client.quit();
  client.disconnect();
}
