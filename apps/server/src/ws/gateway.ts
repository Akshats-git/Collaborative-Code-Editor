import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { CloseCode, MessageType, decodeMessage, encodeMessage } from '@cce/protocol';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { RoomRegistry } from '../rooms/registry.js';
import type { Room } from '../rooms/room.js';
import { Client } from './client.js';
import { Heartbeat } from './heartbeat.js';

const DOCUMENT_PATH = /^\/doc\/([A-Za-z0-9_-]{1,64})$/;

/**
 * Frames a client may send before its document has finished loading. A well
 * behaved client sends one; the cap is there so a hostile one cannot make us
 * buffer indefinitely while a slow read is in flight.
 */
const MAX_QUEUED_FRAMES = 32;

/** Terminates WebSocket connections and routes their frames to the right room. */
export class Gateway {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  private readonly clients = new Set<Client>();
  private readonly heartbeat = new Heartbeat(this.clients, config.heartbeat.intervalMs);

  constructor(private readonly rooms: RoomRegistry) {}

  start(): void {
    this.heartbeat.start();
  }

  get stats(): { connections: number; rooms: number } {
    return { connections: this.clients.size, rooms: this.rooms.openRooms };
  }

  /**
   * Called from the HTTP server's `upgrade` event. Rejecting here means the
   * client never sees a 101, which is cheaper than opening a socket to close it.
   */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const documentId = documentIdFrom(request.url);
    if (!documentId) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.onConnection(ws, documentId);
    });
  }

  async close(): Promise<void> {
    this.heartbeat.stop();
    for (const client of this.clients) {
      client.close(CloseCode.ServerShuttingDown, 'server shutting down');
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await this.rooms.closeAll();
  }

  private onConnection(socket: WebSocket, documentId: string): void {
    const client = new Client(socket, documentId);
    this.clients.add(client);
    logger.info('client connected', { clientId: client.id, documentId });

    // The document may still be loading from the store when the client's first
    // sync frame lands, so hold frames until the room is ready.
    let room: Room | undefined;
    const queued: Uint8Array[] = [];

    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (!isBinary) return;
      try {
        const frame = toUint8Array(data);
        if (room) {
          this.dispatch(room, client, frame);
        } else if (queued.length < MAX_QUEUED_FRAMES) {
          queued.push(frame.slice());
        }
      } catch (error) {
        logger.warn('dropping malformed frame', {
          clientId: client.id,
          documentId,
          error: String(error),
        });
      }
    });

    socket.on('pong', () => {
      client.alive = true;
    });

    socket.on('error', (error) => {
      logger.warn('socket error', { clientId: client.id, error: error.message });
    });

    this.rooms
      .join(client)
      .then((joined) => {
        if (socket.readyState !== socket.OPEN) {
          // Client gave up while we were reading the document.
          return this.rooms.leave(joined, client);
        }

        room = joined;
        socket.on('close', () => void this.onClose(joined, client));

        for (const frame of queued) this.dispatch(joined, client, frame);
        queued.length = 0;
      })
      .catch((error: unknown) => {
        logger.error('failed to open document', {
          documentId,
          error: error instanceof Error ? error.message : String(error),
        });
        this.clients.delete(client);
        client.close(CloseCode.DocumentUnavailable, 'could not load document');
      });
  }

  private async onClose(room: Room, client: Client): Promise<void> {
    this.clients.delete(client);
    await this.rooms.leave(room, client);
    logger.info('client disconnected', { clientId: client.id, documentId: client.documentId });
  }

  private dispatch(room: Room, client: Client, frame: Uint8Array): void {
    const message = decodeMessage(frame);

    switch (message.type) {
      case MessageType.Sync:
        room.handleSync(client, message.payload);
        break;
      case MessageType.Awareness:
        room.handleAwareness(client, message.payload);
        break;
      case MessageType.Ping:
        client.send(encodeMessage({ type: MessageType.Pong }));
        break;
      default:
        break;
    }
  }
}

function documentIdFrom(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const path = url.split('?')[0] ?? '';
  return DOCUMENT_PATH.exec(path)?.[1];
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
