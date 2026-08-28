import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { WebSocket } from 'ws';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { MessageType, decodeMessage, encodeMessage } from '@cce/protocol';

const REMOTE = 'remote';

/**
 * A minimal Yjs client for tests: enough of the sync protocol to talk to the
 * server, plus a byte counter so tests can assert that a reconnect fetches a
 * delta rather than the whole document.
 */
export class TestClient {
  readonly doc = new Y.Doc();
  bytesReceived = 0;

  private socket: WebSocket | undefined;

  private constructor(private readonly url: string) {
    this.doc.on('update', (update, origin) => {
      if (origin === REMOTE) return;
      const encoder = encoding.createEncoder();
      syncProtocol.writeUpdate(encoder, update);
      this.sendSync(encoding.toUint8Array(encoder));
    });
  }

  static async connect(url: string): Promise<TestClient> {
    const client = new TestClient(url);
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
      if (message.type !== MessageType.Sync) return;

      const encoder = encoding.createEncoder();
      syncProtocol.readSyncMessage(decoding.createDecoder(message.payload), encoder, this.doc, REMOTE);
      if (encoding.length(encoder) > 0) this.sendSync(encoding.toUint8Array(encoder));
    });

    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    const encoder = encoding.createEncoder();
    syncProtocol.writeSyncStep1(encoder, this.doc);
    this.sendSync(encoding.toUint8Array(encoder));
  }

  /** Drops the connection but keeps the local document, as a tab going offline would. */
  disconnect(): void {
    this.socket?.close();
    this.socket = undefined;
  }

  close(): void {
    this.disconnect();
    this.doc.destroy();
  }

  private sendSync(payload: Uint8Array): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(encodeMessage({ type: MessageType.Sync, payload }));
  }
}

export function settle(ms = 250): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
