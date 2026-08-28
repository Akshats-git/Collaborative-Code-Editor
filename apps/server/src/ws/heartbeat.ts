import { logger } from '../logger.js';
import type { Client } from './client.js';

/**
 * TCP will happily keep a socket "open" long after the peer has vanished --
 * laptop lid closed, phone off wifi, load balancer dropped the flow. Without a
 * liveness probe those connections sit in memory forever and their cursors stay
 * on everyone else's screen.
 *
 * This uses the WebSocket protocol's own ping/pong control frames rather than an
 * application message, because browsers answer them automatically.
 */
export class Heartbeat {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly clients: Iterable<Client>,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.sweep(), this.intervalMs);
    // Do not hold the event loop open just to run heartbeats.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private sweep(): void {
    for (const client of this.clients) {
      if (!client.alive) {
        // No pong since the previous sweep. terminate(), not close(): a dead peer
        // will never complete the closing handshake.
        logger.warn('terminating unresponsive client', {
          clientId: client.id,
          documentId: client.documentId,
        });
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }
}
