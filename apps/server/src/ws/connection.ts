import { CloseCode, MessageType, decodeMessage, encodeMessage } from '@cce/protocol';
import type { RawData } from 'ws';
import { verifyToken, type SessionClaims } from '../auth/index.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { RoomRegistry } from '../rooms/registry.js';
import type { Room } from '../rooms/room.js';
import type { Client } from './client.js';

/**
 * Frames a client may send between authenticating and its document finishing
 * loading. A well behaved client sends one; the cap stops a hostile one from
 * making us buffer indefinitely behind a slow read.
 */
const MAX_QUEUED_FRAMES = 32;

/**
 * The state machine for a single socket: unauthenticated -> joining -> joined.
 *
 * No room is touched until a valid token arrives, so an unauthenticated socket
 * costs one timer and nothing else.
 */
export class Connection {
  private user: SessionClaims | undefined;
  private room: Room | undefined;
  private readonly queued: Uint8Array[] = [];
  private authTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly client: Client,
    private readonly rooms: RoomRegistry,
    private readonly onClosed: (client: Client) => void,
  ) {}

  start(): void {
    const { socket } = this.client;

    // A socket that never authenticates would otherwise sit here until the
    // heartbeat noticed it, which is 30s of free resources.
    this.authTimer = setTimeout(() => {
      logger.warn('closing unauthenticated socket', { clientId: this.client.id });
      this.client.close(CloseCode.Unauthorized, 'authentication timed out');
    }, config.auth.handshakeTimeoutMs);

    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (!isBinary) return;
      try {
        this.onFrame(toUint8Array(data));
      } catch (error) {
        logger.warn('dropping malformed frame', {
          clientId: this.client.id,
          error: String(error),
        });
      }
    });

    socket.on('pong', () => {
      this.client.alive = true;
    });

    socket.on('error', (error) => {
      logger.warn('socket error', { clientId: this.client.id, error: error.message });
    });

    socket.on('close', () => void this.onSocketClosed());
  }

  private onFrame(frame: Uint8Array): void {
    const message = decodeMessage(frame);

    if (!this.user) {
      if (message.type !== MessageType.Auth) {
        this.client.close(CloseCode.Unauthorized, 'authenticate first');
        return;
      }
      this.authenticate(message.token);
      return;
    }

    if (!this.room) {
      // Still loading the document. The client's state vector arrives here.
      if (this.queued.length < MAX_QUEUED_FRAMES) this.queued.push(frame.slice());
      return;
    }

    this.dispatch(this.room, message);
  }

  private authenticate(token: string): void {
    const claims = verifyToken(token);
    if (!claims) {
      logger.warn('rejected token', { clientId: this.client.id });
      this.client.close(CloseCode.Unauthorized, 'invalid or expired token');
      return;
    }

    clearTimeout(this.authTimer);
    this.authTimer = undefined;
    this.user = claims;

    logger.info('client authenticated', {
      clientId: this.client.id,
      userId: claims.sub,
      documentId: this.client.documentId,
    });

    void this.join();
  }

  private async join(): Promise<void> {
    let room: Room;
    try {
      room = await this.rooms.join(this.client);
    } catch (error) {
      logger.error('failed to open document', {
        documentId: this.client.documentId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.client.close(CloseCode.DocumentUnavailable, 'could not load document');
      return;
    }

    if (this.client.socket.readyState !== this.client.socket.OPEN) {
      // Client gave up while we were reading the document.
      await this.rooms.leave(room, this.client);
      return;
    }

    this.room = room;
    for (const frame of this.queued) this.dispatch(room, decodeMessage(frame));
    this.queued.length = 0;
  }

  private dispatch(room: Room, message: ReturnType<typeof decodeMessage>): void {
    switch (message.type) {
      case MessageType.Sync:
        room.handleSync(this.client, message.payload);
        break;
      case MessageType.Awareness:
        room.handleAwareness(this.client, message.payload);
        break;
      case MessageType.Ping:
        this.client.send(encodeMessage({ type: MessageType.Pong }));
        break;
      default:
        break;
    }
  }

  private async onSocketClosed(): Promise<void> {
    clearTimeout(this.authTimer);
    this.onClosed(this.client);

    if (this.room) {
      await this.rooms.leave(this.room, this.client);
      this.room = undefined;
    }

    logger.info('client disconnected', {
      clientId: this.client.id,
      documentId: this.client.documentId,
    });
  }
}

/** `ws` hands us a Buffer or an array of them; Yjs wants a plain Uint8Array. */
function toUint8Array(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (Array.isArray(data)) {
    return toUint8Array(Buffer.concat(data));
  }
  return new Uint8Array(data);
}
