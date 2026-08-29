import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { WebSocket } from 'ws';
import { CloseCode, MessageType, encodeMessage } from '@cce/protocol';
import { config } from '../src/config.js';
import { Client } from '../src/ws/client.js';
import { TokenBucket } from '../src/ws/rate-limit.js';
import { MemoryDocumentStore } from '../src/persistence/index.js';
import { withServer } from './support/server.js';
import { TestClient, rawConnect, settle, testToken } from './support/y-client.js';

/** Enough of a socket for the backpressure policy, with a settable buffer. */
class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: Uint8Array[] = [];
  closedWith: number | undefined;

  send(frame: Uint8Array): void {
    this.sent.push(frame);
  }

  close(code: number): void {
    this.closedWith = code;
    this.readyState = 3;
  }
}

function fakeClient(): { client: Client; socket: FakeSocket } {
  const socket = new FakeSocket();
  return { client: new Client(socket as unknown as WebSocket, 'doc'), socket };
}

describe('token bucket', () => {
  it('allows a burst up to capacity and then refuses', () => {
    const bucket = new TokenBucket(100, 100);
    assert.equal(bucket.take(60), true);
    assert.equal(bucket.take(40), true);
    assert.equal(bucket.take(1), false);
  });

  it('spends nothing on a request it refuses', () => {
    const bucket = new TokenBucket(100, 100);
    assert.equal(bucket.take(150), false);
    // The oversized request must not have eaten into what is left.
    assert.equal(bucket.take(100), true);
  });

  it('refills with elapsed time', async () => {
    const bucket = new TokenBucket(100, 1000);
    assert.equal(bucket.take(100), true);
    assert.equal(bucket.take(50), false);

    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(bucket.take(50), true);
  });
});

describe('backpressure', () => {
  it('drops presence for a client whose buffer is filling up', () => {
    const { client, socket } = fakeClient();
    const frame = encodeMessage({ type: MessageType.Awareness, payload: new Uint8Array([1]) });

    client.sendPresence(frame);
    assert.equal(socket.sent.length, 1);

    socket.bufferedAmount = config.backpressure.softBytes + 1;
    client.sendPresence(frame);
    client.sendPresence(frame);

    assert.equal(socket.sent.length, 1);
    assert.equal(client.droppedPresence, 2);
  });

  it('never drops a document update, and closes the socket instead', () => {
    const { client, socket } = fakeClient();
    const frame = encodeMessage({ type: MessageType.Sync, payload: new Uint8Array([1]) });

    // Past the presence threshold, document updates still go out.
    socket.bufferedAmount = config.backpressure.softBytes + 1;
    client.send(frame);
    assert.equal(socket.sent.length, 1);

    // Past the hard limit there is nothing honest left to do but disconnect,
    // because the reconnect will resync whatever was missed.
    socket.bufferedAmount = config.backpressure.hardBytes + 1;
    client.send(frame);
    assert.equal(socket.sent.length, 1);
    assert.equal(socket.closedWith, CloseCode.Backpressure);
  });
});

describe('rate limiting', () => {
  it('closes a client that floods document updates', async () => {
    await withServer(new MemoryDocumentStore(), async (url) => {
      const socket = await rawConnect(`${url}/doc/flood`);
      after(() => socket.close());

      const closed = new Promise<number>((resolve) => socket.once('close', resolve));
      socket.send(encodeMessage({ type: MessageType.Auth, token: testToken('flood') }));

      // A valid but empty sync step 1, padded well past the per-second budget.
      const payload = new Uint8Array(128 * 1024);
      const frame = encodeMessage({ type: MessageType.Sync, payload });
      for (let sent = 0; sent < 40; sent += 1) socket.send(frame);

      assert.equal(await closed, CloseCode.RateLimited);
    });
  });

  it('leaves an ordinary editing session alone', async () => {
    await withServer(new MemoryDocumentStore(), async (url) => {
      const client = await TestClient.connect(`${url}/doc/normal`, testToken('normal'));
      after(() => client.close());

      // Faster than anyone types, and nowhere near the limit.
      for (let i = 0; i < 200; i += 1) client.insert(i, 'x');
      await settle();

      assert.equal(client.text.length, 200);
    });
  });
});
