import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import { CloseCode, MessageType, encodeMessage } from '@cce/protocol';
import { createApp } from '../src/app.js';
import { MemoryDocumentStore } from '../src/persistence/index.js';
import { TestClient, settle, testToken } from './support/y-client.js';

const app = createApp({ store: new MemoryDocumentStore() });
let url = '';

before(async () => {
  const port = await app.listen(0);
  url = `ws://127.0.0.1:${port}/doc/private`;
});

after(() => app.close());

/** Opens a raw socket and resolves with the close code the server sends. */
function closeCodeFor(send?: (socket: WebSocket) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    socket.once('open', () => send?.(socket));
    socket.once('close', (code) => resolve(code));
    socket.once('error', reject);
  });
}

test('a socket that sends a document frame before authenticating is rejected', async () => {
  const code = await closeCodeFor((socket) => {
    socket.send(encodeMessage({ type: MessageType.Sync, payload: new Uint8Array([0]) }));
  });
  assert.equal(code, CloseCode.Unauthorized);
});

test('a forged token is rejected', async () => {
  const code = await closeCodeFor((socket) => {
    socket.send(encodeMessage({ type: MessageType.Auth, token: 'not.a.token' }));
  });
  assert.equal(code, CloseCode.Unauthorized);
});

test('a tampered payload does not verify against its signature', async () => {
  const [body, signature] = testToken('mallory').split('.');
  const forged = Buffer.from(JSON.stringify({
    sub: 'user-admin',
    name: 'admin',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');

  assert.notEqual(forged, body);

  const code = await closeCodeFor((socket) => {
    socket.send(encodeMessage({ type: MessageType.Auth, token: `${forged}.${signature}` }));
  });
  assert.equal(code, CloseCode.Unauthorized);
});

test('a valid token joins the room', async () => {
  const client = await TestClient.connect(url, testToken('alice'));
  await settle();
  client.insert(0, 'let in');
  await settle();

  const second = await TestClient.connect(url, testToken('bob'));
  await settle();
  assert.equal(second.text, 'let in');

  client.close();
  second.close();
});
