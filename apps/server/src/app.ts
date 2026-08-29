import type { Server } from 'node:http';
import { createDocumentBus, type DocumentBus } from './cluster/index.js';
import { config } from './config.js';
import { createHttpServer } from './http.js';
import { logger } from './logger.js';
import { createDocumentStore, type DocumentStore } from './persistence/index.js';
import { RoomRegistry } from './rooms/registry.js';
import { Gateway } from './ws/gateway.js';

export interface App {
  /** Resolves with the port actually bound, so tests can pass 0. */
  listen(port: number): Promise<number>;
  close(): Promise<void>;
}

export interface AppOptions {
  /** Overridable for tests. A store passed in here is left open on shutdown. */
  store?: DocumentStore;
  /** Same ownership rule as `store`. Two apps on one bus look like two instances. */
  bus?: DocumentBus;
}

/**
 * Wires the store, the room registry and the WebSocket gateway together and
 * hands back start and stop controls. Keeping this out of `index.ts` lets tests
 * run a real server on an ephemeral port instead of mocking transport.
 */
export function createApp(options: AppOptions = {}): App {
  const store = options.store ?? createDocumentStore();
  const ownsStore = options.store === undefined;
  const bus = options.bus ?? createDocumentBus();
  const ownsBus = options.bus === undefined;
  const rooms = new RoomRegistry(store, config.persistence, bus);
  const gateway = new Gateway(rooms);
  const server: Server = createHttpServer(gateway);

  server.on('upgrade', (request, socket, head) => {
    gateway.handleUpgrade(request, socket, head);
  });

  return {
    listen(port) {
      gateway.start();
      return new Promise((resolve) => {
        server.listen(port, () => {
          const address = server.address();
          const bound = typeof address === 'object' && address ? address.port : port;
          logger.info('server listening', { port: bound });
          resolve(bound);
        });
      });
    },

    async close() {
      // Order matters. Stop accepting frames, flush every room, then drop the
      // connection pool. Reversing it would throw away unwritten updates.
      await gateway.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (ownsBus) await bus.close();
      if (ownsStore) await store.close();
    },
  };
}
