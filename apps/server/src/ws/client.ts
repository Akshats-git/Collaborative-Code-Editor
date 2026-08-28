import type { WebSocket } from 'ws';
import type { CloseCodeValue } from '@cce/protocol';

let nextClientId = 1;

/**
 * One WebSocket connection. Wraps the raw socket so rooms never touch `ws`
 * directly, which keeps the room logic testable without a real server.
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

  constructor(
    readonly socket: WebSocket,
    readonly documentId: string,
  ) {}

  send(frame: Uint8Array): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(frame);
  }

  close(code: CloseCodeValue, reason: string): void {
    this.socket.close(code, reason);
  }
}
