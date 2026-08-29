import { NO_BUS, type DocumentBus } from '../cluster/index.js';
import { logger } from '../logger.js';
import { DocumentWriter, type DocumentStore, type WriterOptions } from '../persistence/index.js';
import type { Client } from '../ws/client.js';
import { Room } from './room.js';

/**
 * Owns the lifetime of every in-memory room. A room is loaded on the first join
 * and dropped when the last client leaves, so an idle instance holds no
 * documents and a quiet document costs a read to reopen.
 */
export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  /** In-flight loads, so two simultaneous joins share one read. */
  private readonly opening = new Map<string, Promise<Room>>();

  constructor(
    private readonly store: DocumentStore,
    private readonly writerOptions: WriterOptions,
    private readonly bus: DocumentBus = NO_BUS,
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
    await this.bus.unsubscribe(room.id);
    await room.destroy();
    logger.info('room closed', { documentId: room.id });
  }

  /** Flushes every open room. Called on shutdown, before the process exits. */
  async closeAll(): Promise<void> {
    const rooms = [...this.rooms.values()];
    this.rooms.clear();
    await Promise.all(
      rooms.map(async (room) => {
        await this.bus.unsubscribe(room.id);
        await room.destroy();
      }),
    );
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
    const room = new Room(documentId, writer, this.bus);

    // Subscribe before hydrating, so an edit made on another instance while we
    // are reading is applied on top of the read rather than lost behind it.
    await this.bus.subscribe(documentId, (message) => room.receive(message));
    if (state) room.hydrate(state);

    this.rooms.set(documentId, room);

    // The store is not the whole truth. An instance that already has this
    // document open may be holding updates it has not written yet.
    room.requestState();
    logger.info('room opened', {
      documentId,
      restored: state !== null,
      pendingUpdates,
      loadMs: Date.now() - started,
    });
    return room;
  }
}
