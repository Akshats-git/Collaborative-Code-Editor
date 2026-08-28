import { logger } from '../logger.js';
import type { Client } from '../ws/client.js';
import { Room } from './room.js';

/**
 * Owns the lifetime of every in-memory room. A room exists only while at least
 * one client is connected to it; the last one out turns the lights off.
 */
export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();

  get openRooms(): number {
    return this.rooms.size;
  }

  join(client: Client): Room {
    let room = this.rooms.get(client.documentId);
    if (!room) {
      room = new Room(client.documentId);
      this.rooms.set(room.id, room);
      logger.info('room opened', { documentId: room.id });
    }
    room.add(client);
    return room;
  }

  leave(room: Room, client: Client): void {
    room.remove(client);
    if (room.clientCount > 0) return;

    this.rooms.delete(room.id);
    room.destroy();
    logger.info('room closed', { documentId: room.id });
  }
}
