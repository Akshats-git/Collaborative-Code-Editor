import { logger } from '../logger.js';
import { DocumentWriter, type DocumentStore, type WriterOptions } from '../persistence/index.js';
import type { Client } from '../ws/client.js';
import { Room } from './room.js';

/**
 * Owns the lifetime of every in-memory room.
 *
 * A room is loaded from the store on the first join and dropped when the last
 * client leaves, so an idle instance holds no documents. The trade is that a
 * document nobody is editing costs a read to reopen.
 */
export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  /** In-flight loads, so two simultaneous joins share one read. */
  private readonly opening = new Map<string, Promise<Room>>();

  constructor(
    private readonly store: DocumentStore,
    private readonly writerOptions: WriterOptions,
  ) {}

  get openRooms(): number {
    return this.rooms.size;
  }

  async join(client: Client): Promise<Room> {
    const room = this.rooms.get(client.documentId) ?? (await this.open(client.documentId));
    room.add(client);
    return room;
  }

  async leave(room: Room, client: Client): Promise<void> {
    room.remove(client);
    if (room.clientCount > 0) return;

    this.rooms.delete(room.id);
    await room.destroy();
    logger.info('room closed', { documentId: room.id });
  }

  /** Flushes every open room. Called on shutdown, before the process exits. */
  async closeAll(): Promise<void> {
    const rooms = [...this.rooms.values()];
    this.rooms.clear();
    await Promise.all(rooms.map((room) => room.destroy()));
  }

  private open(documentId: string): Promise<Room> {
    const inFlight = this.opening.get(documentId);
    if (inFlight) return inFlight;

    const pending = this.load(documentId).finally(() => this.opening.delete(documentId));
    this.opening.set(documentId, pending);
    return pending;
  }

  private async load(documentId: string): Promise<Room> {
    const started = Date.now();
    const { state, pendingUpdates } = await this.store.load(documentId);

    const writer = new DocumentWriter(documentId, this.store, this.writerOptions, pendingUpdates);
    const room = new Room(documentId, writer);
    if (state) room.hydrate(state);

    this.rooms.set(documentId, room);
    logger.info('room opened', {
      documentId,
      restored: state !== null,
      pendingUpdates,
      loadMs: Date.now() - started,
    });
    return room;
  }
}
