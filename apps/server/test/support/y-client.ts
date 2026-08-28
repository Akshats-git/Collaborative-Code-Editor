import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { WebSocket } from 'ws';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { MessageType, decodeMessage, encodeMessage } from '@cce/protocol';
import { issueToken } from '../../src/auth/index.js';

const REMOTE = 'remote';

/** Tokens are signed in-process, so tests do not need the HTTP endpoint. */
export function testToken(name = 'tester'): string {
  return issueToken({ sub: `user-${name}`, name });
}

/**
 * A minimal Yjs client for tests: enough of the sync protocol to talk to the
 * server, plus a byte counter so tests can assert that a reconnect fetches a
 * delta rather than the whole document.
 */
export class TestClient {
  readonly doc = new Y.Doc();
  readonly awareness: Awareness;
  bytesReceived = 0;

  private socket: WebSocket | undefined;

  private constructor(
    private readonly url: string,
    private readonly token: string,
  ) {
    this.awareness = new Awareness(this.doc);
    this.awareness.on('update', (change: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === REMOTE) return;
      const changed = [...change.added, ...change.updated, ...change.removed];
      this.send({
        type: MessageType.Awareness,
        payload: encodeAwarenessUpdate(this.awareness, changed),
      });
    });

    this.doc.on('update', (update, origin) => {
      if (origin === REMOTE) return;
      const encoder = encoding.createEncoder();
      syncProtocol.writeUpdate(encoder, update);
      this.sendSync(encoding.toUint8Array(encoder));
    });
  }

  static async connect(url: string, token = testToken()): Promise<TestClient> {
    const client = new TestClient(url, token);
    await client.open();
    return client;
  }

  get text(): string {
    return this.doc.getText('content').toString();
  }

  insert(index: number, value: string): void {
    this.doc.getText('content').insert(index, value);
  }

  /** Opens the socket and offers the server our current state vector. */
  async open(): Promise<void> {
    const socket = new WebSocket(this.url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.on('message', (data: ArrayBuffer) => {
      this.bytesReceived += data.byteLength;
      const message = decodeMessage(new Uint8Array(data));

      if (message.type === MessageType.Awareness) {
        applyAwarenessUpdate(this.awareness, message.payload, REMOTE);
        return;
      }
      if (message.type !== MessageType.Sync) return;

      const encoder = encoding.createEncoder();
      syncProtocol.readSyncMessage(decoding.createDecoder(message.payload), encoder, this.doc, REMOTE);
      if (encoding.length(encoder) > 0) this.sendSync(encoding.toUint8Array(encoder));
    });

    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    // Auth first: the server drops the socket if anything else arrives before it.
    socket.send(encodeMessage({ type: MessageType.Auth, token: this.token }));

    const encoder = encoding.createEncoder();
    syncProtocol.writeSyncStep1(encoder, this.doc);
    this.sendSync(encoding.toUint8Array(encoder));
  }

  /** Drops the connection but keeps the local document, as a tab going offline would. */
  disconnect(): void {
    this.socket?.close();
    this.socket = undefined;
  }

  /** Display names this client can currently see, excluding its own. */
  peers(): string[] {
    return [...this.awareness.getStates()]
      .filter(([clientId]) => clientId !== this.doc.clientID)
      .map(([, state]) => (state as { user?: { name: string } }).user?.name ?? '?')
      .sort();
  }

  setPresence(name: string): void {
    this.awareness.setLocalStateField('user', { name });
  }

  close(): void {
    this.disconnect();
    this.awareness.destroy();
    this.doc.destroy();
  }

  private sendSync(payload: Uint8Array): void {
    this.send({ type: MessageType.Sync, payload });
  }

  private send(message: Parameters<typeof encodeMessage>[0]): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(encodeMessage(message));
  }
}

export function settle(ms = 250): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
