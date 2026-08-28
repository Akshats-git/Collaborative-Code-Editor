import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Gateway } from './ws/gateway.js';

/**
 * A minimal HTTP surface next to the WebSocket server: Render's health checks
 * need somewhere to poll, and `/healthz` doubles as a way to eyeball how many
 * connections an instance is holding.
 */
export function createHttpServer(gateway: Gateway) {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = (request.url ?? '').split('?')[0];

    if (path === '/healthz') {
      return json(response, 200, { status: 'ok', ...gateway.stats });
    }

    return json(response, 404, { error: 'not found' });
  });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}
