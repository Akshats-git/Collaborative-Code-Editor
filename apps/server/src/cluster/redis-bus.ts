import { Redis } from 'ioredis';
import { logger } from '../logger.js';
import type { BusListener, DocumentBus } from './bus.js';
import { decodeBusMessage, encodeBusMessage, type BusKindValue } from './messages.js';

const CHANNEL_PREFIX = 'cce:doc:';

/** How often a repeating connection error is allowed to reach the log. */
const ERROR_LOG_INTERVAL_MS = 10_000;

/**
 * Fans document traffic out across instances over Redis pub/sub. Two
 * connections, because a client in subscriber mode may not issue ordinary
 * commands.
 *
 * Redis is a relay here, never a source of truth. An unreachable broker is a
 * partition rather than an outage: each instance keeps serving its own clients,
 * and rooms reconverge through the state request issued on reopening.
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
    // Fail publishes fast instead of queueing them. A queued document update is
    // one that arrives out of order minutes later, which is worse than one that
    // never arrives, since the room has converged again by then.
    this.publisher = new Redis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
    // The subscriber keeps its queue. ioredis replays SUBSCRIBE on reconnect,
    // so a room that outlives an outage gets its channel back without our help.
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
      // Not fatal. The room still works locally, and ioredis subscribes for us
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

    // Redis delivers our own publishes back to us. Applying them is harmless,
    // since Yjs updates are idempotent, but it doubles the work.
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
 * QUIT drains anything in flight but only completes while connected, so on a
 * client that never reached the broker it queues forever. `disconnect` is what
 * stops the reconnect loop, without which a process started with Redis down
 * never exits.
 */
async function shutdown(client: Redis): Promise<void> {
  if (client.status === 'ready') await client.quit();
  client.disconnect();
}
