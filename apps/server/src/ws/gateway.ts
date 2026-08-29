import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { CloseCode } from '@cce/protocol';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { RoomRegistry } from '../rooms/registry.js';
import { Client } from './client.js';
import { Connection } from './connection.js';
import { Heartbeat } from './heartbeat.js';

const DOCUMENT_PATH = /^\/doc\/([A-Za-z0-9_-]{1,64})$/;

/** Accepts WebSocket upgrades and hands each one to a Connection. */
export class Gateway {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  private readonly clients = new Set<Client>();
  private readonly heartbeat = new Heartbeat(this.clients, config.heartbeat.intervalMs);

  constructor(private readonly rooms: RoomRegistry) {}

  get stats(): { connections: number; rooms: number } {
    return { connections: this.clients.size, rooms: this.rooms.openRooms };
  }

  start(): void {
    this.heartbeat.start();
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

    new Connection(client, this.rooms, (closed) => this.clients.delete(closed)).start();
  }
}

function documentIdFrom(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const path = url.split('?')[0] ?? '';
  return DOCUMENT_PATH.exec(path)?.[1];
}
