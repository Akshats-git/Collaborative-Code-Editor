import { logger } from '../logger.js';
import type { Client } from './client.js';

/**
 * TCP keeps a socket open long after the peer has vanished, so without a
 * liveness probe those connections sit in memory forever and their cursors stay
 * on everyone else's screen. This uses the protocol's own ping and pong control
 * frames rather than an application message, because browsers answer them
 * automatically.
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
        // No pong since the previous sweep. terminate() rather than close(),
        // because a dead peer will never complete the closing handshake.
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
