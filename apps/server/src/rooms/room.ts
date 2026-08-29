import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { MessageType, encodeMessage } from '@cce/protocol';
import { BusKind, EMPTY_PAYLOAD, NO_BUS, type BusMessage, type DocumentBus } from '../cluster/index.js';
import { NO_PERSISTENCE, type UpdateSink } from '../persistence/store.js';
import { Client } from '../ws/client.js';

/**
 * Transaction origin used when replaying stored state into a fresh document, so
 * the writer does not immediately persist what it just read back.
 */
const HYDRATE = Symbol('hydrate');

/**
 * Transaction origin for anything that arrived from another instance. Such an
 * update still has to reach the clients on this instance, but it must not be
 * published back onto the bus, and it is not ours to persist.
 */
const REMOTE = Symbol('remote');

/**
 * A room is a document plus everyone currently editing it.
 *
 * Document state and awareness state are deliberately kept on separate paths:
 * the document is durable and must never lose an update, awareness is
 * throwaway presence data that we are free to drop.
 */
export class Room {
  readonly doc = new Y.Doc();
  readonly awareness: awarenessProtocol.Awareness;

  private readonly clients = new Set<Client>();

  constructor(
    readonly id: string,
    private readonly sink: UpdateSink = NO_PERSISTENCE,
    private readonly bus: DocumentBus = NO_BUS,
  ) {
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    // The server observes presence but is not itself a participant.
    this.awareness.setLocalState(null);

    this.doc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwarenessUpdate);
  }

  /** Replays persisted state into an empty room, before any client joins. */
  hydrate(state: Uint8Array): void {
    Y.applyUpdate(this.doc, state, HYDRATE);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  get text(): Y.Text {
    return this.doc.getText('content');
  }

  add(client: Client): void {
    this.clients.add(client);

    // Step 1 of the Yjs sync protocol: "here is what I have, tell me what I am
    // missing". The client answers with its own step 1 and a step 2 reply.
    const sync = encoding.createEncoder();
    syncProtocol.writeSyncStep1(sync, this.doc);
    client.send(encodeMessage({ type: MessageType.Sync, payload: encoding.toUint8Array(sync) }));

    const states = this.awareness.getStates();
    if (states.size > 0) {
      client.sendPresence(
        encodeMessage({
          type: MessageType.Awareness,
          payload: awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()]),
        }),
      );
    }
  }

  remove(client: Client): void {
    this.clients.delete(client);
    if (client.controlledAwarenessIds.size > 0) {
      awarenessProtocol.removeAwarenessStates(
        this.awareness,
        [...client.controlledAwarenessIds],
        'disconnect',
      );
    }
  }

  handleSync(client: Client, payload: Uint8Array): void {
    const decoder = decoding.createDecoder(payload);
    const encoder = encoding.createEncoder();

    // The client is passed as the transaction origin so the update handler below
    // can skip echoing the change back to whoever sent it.
    syncProtocol.readSyncMessage(decoder, encoder, this.doc, client);

    if (encoding.length(encoder) > 0) {
      client.send(encodeMessage({ type: MessageType.Sync, payload: encoding.toUint8Array(encoder) }));
    }
  }

  handleAwareness(client: Client, payload: Uint8Array): void {
    awarenessProtocol.applyAwarenessUpdate(this.awareness, payload, client);
  }

  /** Applies a message another instance published for this document. */
  receive(message: BusMessage): void {
    switch (message.kind) {
      case BusKind.Update:
        Y.applyUpdate(this.doc, message.payload, REMOTE);
        break;

      case BusKind.Awareness:
        awarenessProtocol.applyAwarenessUpdate(this.awareness, message.payload, REMOTE);
        break;

      case BusKind.StateRequest:
        if (this.clientCount > 0) this.answerStateRequest();
        break;
    }
  }

  /** Asks any instance already holding this document for what it has. */
  requestState(): void {
    this.bus.publish(this.id, BusKind.StateRequest, EMPTY_PAYLOAD);
  }

  /**
   * Brings an instance that has just opened this document up to date.
   *
   * Both halves matter and neither is in Postgres. The document we accepted in
   * the last few hundred milliseconds is still in our write buffer, so their
   * read cannot have seen it. Presence is never written at all, so without this
   * the people already editing stay invisible to whoever joins the new instance
   * until they next move their cursor.
   *
   * The duplicate bytes cost a merge the receiver would have done anyway.
   */
  private answerStateRequest(): void {
    this.bus.publish(this.id, BusKind.Update, Y.encodeStateAsUpdate(this.doc));

    const states = this.awareness.getStates();
    if (states.size === 0) return;
    this.bus.publish(
      this.id,
      BusKind.Awareness,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()]),
    );
  }

  async destroy(): Promise<void> {
    // Flush before tearing anything down: this is the path a graceful shutdown
    // and the last-client-leaves case both take.
    await this.sink.close();

    this.doc.off('update', this.onDocUpdate);
    this.awareness.off('update', this.onAwarenessUpdate);
    this.awareness.destroy();
    this.doc.destroy();
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    // Replayed state is already stored, and a remote update belongs to the
    // instance that accepted it -- persisting it here would write the same bytes
    // once per instance and republishing it would loop.
    if (origin !== HYDRATE && origin !== REMOTE) {
      this.sink.record(update);
      this.bus.publish(this.id, BusKind.Update, update);
    }

    const encoder = encoding.createEncoder();
    syncProtocol.writeUpdate(encoder, update);
    const frame = encodeMessage({ type: MessageType.Sync, payload: encoding.toUint8Array(encoder) });

    for (const client of this.clients) {
      if (client !== origin) client.send(frame);
    }
  };

  private onAwarenessUpdate = (
    change: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin instanceof Client) {
      for (const id of change.added) origin.controlledAwarenessIds.add(id);
      for (const id of change.removed) origin.controlledAwarenessIds.delete(id);
    }

    const changed = [...change.added, ...change.updated, ...change.removed];
    const payload = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed);
    if (origin !== REMOTE) this.bus.publish(this.id, BusKind.Awareness, payload);

    const frame = encodeMessage({ type: MessageType.Awareness, payload });

    for (const client of this.clients) {
      // Presence, not document state: droppable, and dropped first when a
      // client's send buffer starts filling up.
      if (client !== origin) client.sendPresence(frame);
    }
  };
}
