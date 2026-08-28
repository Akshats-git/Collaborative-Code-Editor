import type { Server } from 'node:http';
import { createHttpServer } from './http.js';
import { logger } from './logger.js';
import { Gateway } from './ws/gateway.js';

export interface App {
  /** Resolves with the port actually bound, so tests can pass 0. */
  listen(port: number): Promise<number>;
  close(): Promise<void>;
}

/**
 * Wires the HTTP server to the WebSocket gateway and hands back start/stop
 * controls. Keeping this separate from `index.ts` means tests can run a real
 * server on an ephemeral port instead of mocking the transport.
 */
export function createApp(): App {
  const gateway = new Gateway();
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
      await gateway.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
