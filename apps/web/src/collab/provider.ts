import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import type * as Y from 'yjs';
import {
  CloseCode,
  MessageType,
  decodeMessage,
  encodeMessage,
  isTerminalCloseCode,
  type Message,
} from '@cce/protocol';
import type { TokenRequest } from '../auth.js';

export type ConnectionStatus = 'connecting' | 'connected' | 'offline' | 'rejected';

export interface CollabProviderOptions {
  url: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  /** Resolves a session token. Called before every connection attempt. */
  getToken(request: TokenRequest): Promise<string>;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;

/**
 * How long a socket has to survive before the backoff resets. Resetting on
 * `open` looks right and is not: the server can accept a socket and close it
 * immediately, which is what rate limiting does, and a client resetting on
 * every open would reconnect into the same wall twice a second forever.
 */
const CONNECTION_STABLE_MS = 5_000;

/**
 * The browser WebSocket API does not expose protocol-level ping and pong
 * frames, so the server's heartbeat is invisible here. Noticing a silently dead
 * server needs our own probe in the other direction.
 */
const PING_INTERVAL_MS = 20_000;
const PONG_TIMEOUT_MS = 10_000;

/**
 * y-protocols discards awareness state it has not heard about for 30 seconds,
 * which stops a client that vanished without a close frame from haunting
 * everyone else's screen. The cost is that someone reading rather than typing
 * looks like they left, so we re-announce on a shorter cycle.
 */
const AWARENESS_REFRESH_MS = 10_000;

/**
 * Speaks the Yjs sync and awareness protocols over a single binary WebSocket,
 * and keeps that socket alive across network drops. Hand rolled rather than
 * `y-websocket`, because reconnect, heartbeat and backoff are the parts of this
 * project worth being able to explain.
 */
export class CollabProvider {
  private readonly doc: Y.Doc;
  private readonly awareness: awarenessProtocol.Awareness;
  private readonly url: string;
  private readonly getToken: (request: TokenRequest) => Promise<string>;

  private socket: WebSocket | undefined;
  private status: ConnectionStatus = 'offline';
  private readonly listeners = new Set<(status: ConnectionStatus) => void>();

  private attempt = 0;
  /** Set when the server refused our token, so the next attempt asks for a new one. */
  private refreshToken = false;
  private reconnectTimer: number | undefined;
  private pingTimer: number | undefined;
  private pongTimer: number | undefined;
  private awarenessTimer: number | undefined;
  private stableTimer: number | undefined;
  private destroyed = false;

  constructor({ url, doc, awareness, getToken }: CollabProviderOptions) {
    this.url = url;
    this.doc = doc;
    this.awareness = awareness;
    this.getToken = getToken;

    this.doc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwarenessUpdate);
    window.addEventListener('beforeunload', this.onUnload);

    void this.connect();
  }

  onStatusChange(listener: (status: ConnectionStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    this.destroyed = true;
    this.doc.off('update', this.onDocUpdate);
    this.awareness.off('update', this.onAwarenessUpdate);
    window.removeEventListener('beforeunload', this.onUnload);
    this.clearTimers();
    this.socket?.close();
    this.socket = undefined;
  }

  private async connect(): Promise<void> {
    if (this.destroyed) return;
    this.setStatus('connecting');

    // The token is fetched before the socket opens, not after. The server drops
    // sockets that do not authenticate within a few seconds, and this way an
    // expired token costs an HTTP round trip rather than a failed connection.
    let token: string;
    try {
      token = await this.getToken({ refresh: this.refreshToken });
      this.refreshToken = false;
    } catch {
      this.setStatus('offline');
      this.scheduleReconnect();
      return;
    }
    if (this.destroyed) return;

    const socket = new WebSocket(this.url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => {
      this.stableTimer = window.setTimeout(() => {
        this.attempt = 0;
      }, CONNECTION_STABLE_MS);
      this.setStatus('connected');

      // Must be the first frame. Anything else and the server closes the socket.
      this.send({ type: MessageType.Auth, token });

      // Step 1 carries our state vector, not the document. On a reconnect the
      // server answers with only the updates we missed, so a 30 second dropout
      // costs a few hundred bytes rather than a full document fetch.
      const sync = encoding.createEncoder();
      syncProtocol.writeSyncStep1(sync, this.doc);
      this.send({ type: MessageType.Sync, payload: encoding.toUint8Array(sync) });

      if (this.awareness.getLocalState() !== null) {
        this.send({
          type: MessageType.Awareness,
          payload: awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
        });
      }

      this.startPinging();
      this.startAnnouncing();
    };

    socket.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      this.onFrame(new Uint8Array(event.data));
    };

    socket.onclose = (event) => {
      this.clearTimers();
      this.socket = undefined;

      // Everyone else's cursors are stale the moment we lose the socket.
      awarenessProtocol.removeAwarenessStates(
        this.awareness,
        [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID),
        'disconnect',
      );

      if (this.destroyed) return;

      if (isTerminalCloseCode(event.code)) {
        this.setStatus('rejected');
        return;
      }

      // Most often an expired token. Reconnect, but ask for a fresh one first.
      if (event.code === CloseCode.Unauthorized) this.refreshToken = true;

      this.setStatus('offline');
      this.scheduleReconnect();
    };

    // `onerror` is always followed by `onclose`, so reconnect is handled there.
    socket.onerror = () => socket.close();
  }

  private onFrame(frame: Uint8Array): void {
    const message = decodeMessage(frame);

    switch (message.type) {
      case MessageType.Sync: {
        const decoder = decoding.createDecoder(message.payload);
        const encoder = encoding.createEncoder();
        syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
        if (encoding.length(encoder) > 0) {
          this.send({ type: MessageType.Sync, payload: encoding.toUint8Array(encoder) });
        }
        break;
      }
      case MessageType.Awareness:
        awarenessProtocol.applyAwarenessUpdate(this.awareness, message.payload, this);
        break;
      case MessageType.Pong:
        if (this.pongTimer !== undefined) window.clearTimeout(this.pongTimer);
        this.pongTimer = undefined;
        break;
      default:
        break;
    }
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    // Updates that arrived from the server are already applied everywhere.
    if (origin === this) return;

    const encoder = encoding.createEncoder();
    syncProtocol.writeUpdate(encoder, update);
    this.send({ type: MessageType.Sync, payload: encoding.toUint8Array(encoder) });
  };

  private onAwarenessUpdate = (
    change: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === this) return;

    const changed = [...change.added, ...change.updated, ...change.removed];
    this.send({
      type: MessageType.Awareness,
      payload: awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
    });
  };

  private onUnload = (): void => {
    // Tell the room we are gone while the socket is still open, instead of
    // making everyone wait out the server's heartbeat interval.
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'unload');
  };

  private send(message: Message): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(encodeMessage(message));
  }

  private startPinging(): void {
    this.pingTimer = window.setInterval(() => {
      if (this.pongTimer !== undefined) return;

      this.send({ type: MessageType.Ping });
      this.pongTimer = window.setTimeout(() => {
        // Socket looks open but nothing is coming back. Drop it and let the
        // close handler reconnect.
        this.socket?.close();
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  private startAnnouncing(): void {
    this.awarenessTimer = window.setInterval(() => {
      const local = this.awareness.getLocalState();
      // Re-setting the same state bumps its clock, which is all the other side
      // needs to keep the entry alive.
      if (local !== null) this.awareness.setLocalState(local);
    }, AWARENESS_REFRESH_MS);
  }

  private scheduleReconnect(): void {
    // Exponential backoff with jitter. Without the jitter, every client knocked
    // off by one server restart comes back in the same millisecond.
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.attempt);
    const jittered = delay * (0.5 + Math.random() * 0.5);
    this.attempt += 1;

    this.reconnectTimer = window.setTimeout(() => void this.connect(), jittered);
  }

  private clearTimers(): void {
    if (this.pingTimer !== undefined) window.clearInterval(this.pingTimer);
    if (this.pongTimer !== undefined) window.clearTimeout(this.pongTimer);
    if (this.awarenessTimer !== undefined) window.clearInterval(this.awarenessTimer);
    if (this.stableTimer !== undefined) window.clearTimeout(this.stableTimer);
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    this.pingTimer = undefined;
    this.pongTimer = undefined;
    this.awarenessTimer = undefined;
    this.stableTimer = undefined;
    this.reconnectTimer = undefined;
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }
}
