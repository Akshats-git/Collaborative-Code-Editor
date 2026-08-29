import type { WebSocket } from 'ws';
import { CloseCode, type CloseCodeValue } from '@cce/protocol';
import { config } from '../config.js';
import { logger } from '../logger.js';

let nextClientId = 1;

/**
 * One WebSocket connection. Wraps the raw socket so rooms never touch `ws`
 * directly, which keeps the room logic testable without a real server.
 *
 * This is also where backpressure is handled, because this is the only place
 * that knows how far behind a particular client is.
 */
export class Client {
  readonly id = nextClientId++;

  /**
   * Awareness clientIDs this connection is responsible for. On disconnect we
   * clear exactly these, so one user's cursor never lingers on other screens.
   */
  readonly controlledAwarenessIds = new Set<number>();

  /** Cleared before each heartbeat ping, set again when the pong arrives. */
  alive = true;

  /** Presence frames skipped because this client could not keep up. */
  droppedPresence = 0;

  private warnedSlow = false;

  constructor(
    readonly socket: WebSocket,
    readonly documentId: string,
  ) {}

  /**
   * Sends something the client cannot be allowed to miss.
   *
   * There is no version of this that drops a frame. A document update the
   * server has already applied and broadcast to everyone else cannot quietly
   * not arrive here -- that is a permanently diverged client, and it looks like
   * a CRDT bug rather than a network problem. So when a socket is hopelessly
   * behind the honest move is to close it: the reconnect re-offers a state
   * vector and the server replies with exactly what was missed.
   */
  send(frame: Uint8Array): void {
    if (this.socket.readyState !== this.socket.OPEN) return;

    if (this.socket.bufferedAmount > config.backpressure.hardBytes) {
      logger.warn('closing client that cannot keep up', {
        clientId: this.id,
        documentId: this.documentId,
        buffered: this.socket.bufferedAmount,
      });
      this.close(CloseCode.Backpressure, 'too far behind');
      return;
    }

    this.socket.send(frame);
  }

  /**
   * Sends something it is fine to lose. Presence only.
   *
   * A cursor position that never arrives is corrected by the next one a few
   * hundred milliseconds later, so dropping these is how a slow client stops
   * being everyone else's problem before it becomes its own.
   */
  sendPresence(frame: Uint8Array): void {
    if (this.socket.readyState !== this.socket.OPEN) return;

    if (this.socket.bufferedAmount > config.backpressure.softBytes) {
      this.droppedPresence += 1;
      if (!this.warnedSlow) {
        this.warnedSlow = true;
        logger.warn('dropping presence for slow client', {
          clientId: this.id,
          documentId: this.documentId,
          buffered: this.socket.bufferedAmount,
        });
      }
      return;
    }

    this.socket.send(frame);
  }

  close(code: CloseCodeValue, reason: string): void {
    this.socket.close(code, reason);
  }
}
