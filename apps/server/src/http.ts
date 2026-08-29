import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, normalize, sep, extname } from 'node:path';
import { issueToken } from './auth/index.js';
import { config } from './config.js';
import type { Gateway } from './ws/gateway.js';

const MAX_BODY_BYTES = 1024;

/**
 * The HTTP surface next to the WebSocket server: a health endpoint for Render's
 * checks, the endpoint that hands out session tokens, and -- when a build is
 * present -- the web app itself. Serving the client from the process that holds
 * its sockets open collapses the deployment to one service on one origin.
 */
export function createHttpServer(gateway: Gateway) {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    response.setHeader('access-control-allow-origin', config.corsOrigin);
    response.setHeader('access-control-allow-headers', 'content-type');
    response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    const path = (request.url ?? '').split('?')[0] ?? '/';

    if (path === '/healthz') {
      json(response, 200, { status: 'ok', instance: config.instanceId, ...gateway.stats });
      return;
    }

    if (path === '/api/session' && request.method === 'POST') {
      void createSession(request, response);
      return;
    }

    if (request.method === 'GET' && config.webRoot) {
      void serveApp(path, response);
      return;
    }

    json(response, 404, { error: 'not found' });
  });
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Serves the built client, falling back to index.html for anything that is not
 * a file on disk: the client is a single page and resolves its own routes.
 */
async function serveApp(urlPath: string, response: ServerResponse): Promise<void> {
  const root = config.webRoot;
  let file = join(root, normalize(decodeURIComponent(urlPath)));

  // `normalize` collapses `..`, so a path that still escapes the root was
  // trying to; treat it as a miss rather than an error and serve the page.
  if (!file.startsWith(root + sep) || !(await isFile(file))) {
    file = join(root, 'index.html');
    if (!(await isFile(file))) {
      json(response, 404, { error: 'not found' });
      return;
    }
  }

  const isEntry = file.endsWith('index.html');
  response.writeHead(200, {
    'content-type': MIME_TYPES[extname(file)] ?? 'application/octet-stream',
    // Vite fingerprints every asset filename, so only the entry point needs to
    // be re-fetched after a deploy.
    'cache-control': isEntry ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  createReadStream(file).pipe(response);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Issues a session token.
 *
 * There is no account system: this hands a token to whoever asks for one, and
 * the display name is whatever they typed. What it establishes is the
 * *mechanism* -- a signed, short-lived, verifiable credential that the socket
 * demands before joining a room. Putting a real identity provider behind it
 * means changing this function and nothing else.
 */
async function createSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
  let body: { name?: unknown };
  try {
    body = JSON.parse(await readBody(request)) as { name?: unknown };
  } catch {
    json(response, 400, { error: 'expected a JSON body' });
    return;
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length < 1 || name.length > 32) {
    json(response, 400, { error: 'name must be 1-32 characters' });
    return;
  }

  const user = { sub: randomUUID(), name };
  json(response, 200, {
    token: issueToken(user),
    user: { id: user.sub, name: user.name },
    expiresIn: config.auth.ttlSeconds,
  });
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
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
